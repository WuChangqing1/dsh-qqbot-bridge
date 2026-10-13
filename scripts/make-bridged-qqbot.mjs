#!/usr/bin/env node
// Create a locally patched copy of @tencent-connect/dsh-qqbot.
//
// The copy adds ONE extension point (see patches/0001-qqbot-extension-point.md)
// so that dsh-qqbot-bridge can borrow the gateway the QQ plugin already runs,
// instead of opening a competing second websocket connection.
//
// The script is deliberately conservative:
//   * it refuses to run twice on an already-patched tree;
//   * it verifies every anchor before writing, and aborts if one is missing;
//   * it never edits the installed npm package in place -- the fork is a
//     separate directory, so rollback is a one-line dependency change.
//
// Usage:
//   node scripts/make-bridged-qqbot.mjs --out <dir> [--from <installed package dir>]

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const MARKER = 'PATCH-0001-APPLIED.md'

const die = message => {
  console.error(`[make-bridged-qqbot] ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const valueOf = flag => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Locate the installed package, preferring the web profile's copy. */
const locateSource = async explicit => {
  if (explicit !== undefined) return resolve(explicit)
  const candidates = []
  const profileDir = process.env.DSH_QQBOT_PROFILE
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web')
  candidates.push(join(profileDir, 'node_modules', '@tencent-connect', 'dsh-qqbot'))
  try {
    const require = createRequire(import.meta.url)
    candidates.push(dirname(require.resolve('@tencent-connect/dsh-qqbot/package.json')))
  } catch {
    // not resolvable from here; the profile candidate usually is
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  die(`cannot find an installed @tencent-connect/dsh-qqbot. Pass --from <dir>. Tried:\n  ${candidates.join('\n  ')}`)
}

const main = async () => {
  const out = valueOf('--out')
  if (out === undefined) die('missing --out <dir>')
  const outDir = resolve(out)
  const sourceDir = await locateSource(valueOf('--from'))

  const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@tencent-connect/dsh-qqbot') {
    die(`${sourceDir} is ${manifest.name}, not @tencent-connect/dsh-qqbot`)
  }

  if (existsSync(join(outDir, MARKER))) {
    die(`${outDir} already carries ${MARKER}; refusing to patch twice. Delete the directory to redo it.`)
  }
  if (existsSync(outDir)) {
    const entries = await stat(outDir)
    if (entries.isDirectory()) {
      const files = await readFile(join(outDir, 'package.json'), 'utf8').catch(() => undefined)
      if (files !== undefined) die(`${outDir} already holds a package; refusing to overwrite.`)
    }
  }

  console.log(`[make-bridged-qqbot] source: ${sourceDir} (v${manifest.version})`)
  console.log(`[make-bridged-qqbot] target: ${outDir}`)
  await mkdir(outDir, { recursive: true })
  // The filter must look at the path RELATIVE to the source: the source itself
  // normally sits inside a `node_modules` tree, and matching on the absolute
  // path would exclude everything.
  await cp(sourceDir, outDir, {
    recursive: true,
    force: true,
    filter: source => {
      const rel = relative(sourceDir, source)
      return rel === '' || !rel.split(/[\\/]/).includes('node_modules')
    },
  })

  // ── A. middleware-setup.js: accept pre-handlers ─────────────────────────
  const middlewarePath = join(outDir, 'dist', 'gateway', 'middleware-setup.js')
  const middlewareBefore = await readFile(middlewarePath, 'utf8')
  const middlewareAnchor = 'export function setupMiddlewares(bot, config, manager, logger) {'
  if (!middlewareBefore.includes(middlewareAnchor)) {
    die(`anchor not found in ${middlewarePath}; the upstream build changed, review patches/0001.`)
  }
  const middlewareAfter = middlewareBefore.replace(
    middlewareAnchor,
    `export function setupMiddlewares(bot, config, manager, logger, preHandlers = []) {
    // PATCH 0001 (dsh-qqbot-bridge): external pre-handlers run BEFORE the stock
    // chain, so a bridge can consume a message before accessPolicy, mentionGate,
    // slashCommand or concurrencyGuard see it. Returning true stops the chain and
    // the stock 'message' handler never fires; returning false leaves every
    // middleware below behaving exactly as before.
    //
    // ONE wrapper is registered, and it resolves the handler LIST on every
    // message instead of at registration time. That matters: the published
    // service offers \`setMessagePreHandler\`, which a consumer normally calls
    // while the gateway is starting -- i.e. AFTER this function has run.
    // Iterating the array here (as the first version of this patch did) would
    // therefore register nothing, and the extension point would silently do
    // nothing while the stock agent answered every message the bridge was
    // supposed to own.
    bot.use(async (ctx, next) => {
        for (const preHandler of preHandlers) {
            let owned = false;
            try {
                owned = preHandler(ctx) === true;
            }
            catch (error) {
                // A broken bridge must not take the QQ pipeline down; fail open
                // so the stock agent still answers.
                ctx.log.error?.(\`[qqbot-bridge] pre-handler failed: \${error instanceof Error ? error.message : String(error)}\`);
            }
            if (owned) {
                ctx.stop('qqbot-bridge:consumed');
                return;
            }
        }
        return next();
    });`,
  )
  await writeFile(middlewarePath, middlewareAfter, 'utf8')

  // ── B. bootstrap.js: publish the gateway as a cordis service ────────────
  const bootstrapPath = join(outDir, 'dist', 'gateway', 'bootstrap.js')
  let bootstrap = await readFile(bootstrapPath, 'utf8')

  // The service block MUST be inserted after `const bot = new QQBot(...)`:
  // `qqbotService` closes over `bot`, and inserting before that declaration
  // leaves `bot` in its temporal dead zone (a real ReferenceError, which this
  // patch hit once and the integration test now guards against).
  // `setupMiddlewares(bot, ...)` is the first statement guaranteed to be past
  // that declaration, so the block goes immediately before it.
  const setupAnchor = 'setupMiddlewares(bot, config, manager, logger);'
  if (!bootstrap.includes(setupAnchor)) die(`anchor "setupMiddlewares" not found in ${bootstrapPath}`)
  bootstrap = bootstrap.replace(
    setupAnchor,
    `// PATCH 0001 (dsh-qqbot-bridge): the pre-handler slot and the sender the
    // published service exposes. Both are inert until setMessagePreHandler is
    // called, so an unpatched consumer of this plugin is unaffected.
    const bridgePreHandlers = [];
    let bridgeSender;
    // Registering a service needs ctx.provide(), NOT ctx.set(). In Cordis 4,
    // \`set\` may only OVERWRITE a service that a fiber already provided and
    // throws "cannot set property \\"<name>\\" without provide" otherwise.
    // provide() also ties the registration to this fiber, so unloading or
    // reloading this plugin removes the service automatically.
    const provideQqbot = ctx.provide?.bind(ctx);
    if (typeof provideQqbot !== 'function') {
        throw new Error('this dsh runtime has no ctx.provide(); patch 0001 requires Cordis 4');
    }
    const qqbotService = {
        bot,
        manager,
        config,
        get sender() { return bridgeSender; },
        /**
         * Build a passive-reply target for one peer. The stock sender resolves
         * the msgId itself (explicit -> cached -> active push), so no cached id
         * is copied here. Part of the published service contract.
         */
        replyTargetFor(scope, targetId) {
            return { scope: scope === 'group' ? 'group' : 'c2c', targetId };
        },
        /**
         * Install (or replace) the bridge's pre-handler.
         *
         * Replacing rather than rejecting is deliberate: a hot reload or a
         * plugin restart calls this again, and throwing there would leave the
         * gateway with NO handler after a successful reload.
         * @returns a disposer that removes this handler.
         */
        setMessagePreHandler(handler) {
            if (typeof handler !== 'function') throw new TypeError('setMessagePreHandler expects a function');
            const existing = bridgePreHandlers.indexOf(handler);
            if (existing !== -1) bridgePreHandlers.splice(existing, 1);
            bridgePreHandlers.push(handler);
            return () => {
                const at = bridgePreHandlers.indexOf(handler);
                if (at !== -1) bridgePreHandlers.splice(at, 1);
            };
        },
        /** How many pre-handlers are installed (diagnostics). */
        get preHandlerCount() { return bridgePreHandlers.length; },
    };
    if (typeof provideQqbot('qqbot', qqbotService) !== 'function') {
        throw new Error('ctx.provide("qqbot", ...) did not return a disposer');
    }
    setupMiddlewares(bot, config, manager, logger, bridgePreHandlers);`,
  )

  const senderAnchor = 'const outboundHandler = createOutboundHandler(manager, sender, config, logger, toolsRegistry);'
  if (!bootstrap.includes(senderAnchor)) die(`anchor "outboundHandler" not found in ${bootstrapPath}`)
  bootstrap = bootstrap.replace(senderAnchor, `bridgeSender = sender;
    ${senderAnchor}`)

  await writeFile(bootstrapPath, bootstrap, 'utf8')

  // ── marker + manifest notes ─────────────────────────────────────────────
  const patched = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf8'))
  await writeFile(
    join(outDir, MARKER),
    [
      '# Patch 0001 applied',
      '',
      `* upstream: \`${manifest.name}@${manifest.version}\``,
      `* source: \`${sourceDir}\``,
      `* applied: ${new Date().toISOString()}`,
      `* generator: \`scripts/make-bridged-qqbot.mjs\``,
      '',
      'Adds `ctx.set(\'qqbot\', ...)` with `setMessagePreHandler(handler)` and a',
      'pre-handler slot at the head of the middleware chain.',
      'See `patches/0001-qqbot-extension-point.md` for the full diff and rollback.',
      'Do not edit these files by hand: regenerate with the script.',
      '',
    ].join('\n'),
    'utf8',
  )

  console.log('[make-bridged-qqbot] patched:')
  console.log('  dist/gateway/middleware-setup.js  (pre-handler slot)')
  console.log('  dist/gateway/bootstrap.js         (ctx.provide service)')
  console.log('')
  console.log('Next:')
  console.log(`  1. point profiles/web/package.json at the fork:`)
  console.log(`       "@tencent-connect/dsh-qqbot": "link:${outDir.replace(/\\/g, '/')}"`)
  console.log(`     (dsh.profile.bundles keeps the name "@tencent-connect/dsh-qqbot")`)
  console.log('  2. stop the dsh host, then run `pnpm install` in the profile directory')
  console.log('  3. restart dsh; look for "borrowing the running im-qqbot gateway" in the log')
  return patched
}

main().catch(error => die(error?.stack ?? String(error)))
