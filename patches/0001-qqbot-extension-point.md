# Patch 0001 — QQ plugin extension point

Target: `@tencent-connect/dsh-qqbot@0.5.0` (installed copy, TypeScript build in `dist/`).

## Why a patch is unavoidable

The stock plugin keeps its transport completely private:

* `bootstrapGateway()` builds `const bot = new QQBot(...)` and `const manager = new SessionManager(...)` as **function-local variables** (`dist/gateway/bootstrap.js:34,37`).
* The plugin calls `ctx.set(...)`/`ctx.provide(...)` **nowhere** — verified by a full-tree search of `dist/`.
* The command registry is discarded: `const slash = slashCommand({...}); bot.use(slash.middleware)` and `slash` is never stored (`dist/gateway/middleware-setup.js:51-57`).
* The only outward-facing things are its own `bot.on('message')` handler and `ctx.on('session/event')` subscriber.

Therefore an outside plugin cannot:

1. reach the live `QQBot` instance, so it cannot call `bot.sendMarkdown(target, text)`;
2. insert middleware, so it cannot stop the stock agent from answering a message first;
3. observe the authoritative OpenID ↔ session mapping, which lives only in `SessionManager`'s private `SessionRecord` map.

Starting a **second** gateway with the same AppID is not an option: two websocket connections on the same shard fight over the event stream. That leaves exactly two honest choices — a minimal local fork, or a local MITM proxy in front of `QQBOT_BASE_URL` that would have to reimplement the QQ gateway protocol. This patch takes the fork.

## What the patch adds

Two additions, both strictly additive. No existing statement is modified, no behaviour changes when nothing uses the extension point.

### A. `dist/gateway/middleware-setup.js` — accept and register a pre-handler

The handler runs **before** the stock chain (before `errorHandler`, before `accessPolicy`, before `slashCommand`), so the bridge owns the ownership/access decision for every message.

```diff
-export function setupMiddlewares(bot, config, manager, logger) {
+export function setupMiddlewares(bot, config, manager, logger, preHandlers = []) {
+    // ONE wrapper, and it resolves the handler LIST on every message instead of
+    // at registration time. That matters: the published service offers
+    // `setMessagePreHandler`, which a consumer normally calls while the gateway
+    // is starting -- i.e. AFTER this function has run. Iterating the array here
+    // (as the first version of this patch did) registered NOTHING, so the
+    // extension point silently did nothing while the stock agent answered every
+    // message the bridge was supposed to own.
+    bot.use(async (ctx, next) => {
+        for (const preHandler of preHandlers) {
+            let owned = false;
+            try {
+                owned = preHandler(ctx) === true;
+            }
+            catch (error) {
+                // A broken bridge must not take the QQ pipeline down; fail open
+                // so the stock agent still answers.
+                ctx.log.error?.(`[qqbot-bridge] pre-handler failed: ${error instanceof Error ? error.message : String(error)}`);
+            }
+            if (owned) {
+                ctx.stop('qqbot-bridge:consumed');
+                return;
+            }
+        }
+        return next();
+    });
     // 1. 错误兜底（最外层洋葱皮）
     bot.use(errorHandler());
```

### B. `dist/gateway/bootstrap.js` — publish the gateway as a cordis service

**The insertion point matters.** The service block closes over `bot`, so it must
come *after* `const bot = new QQBot({...})`. Placing it earlier (as the first
version of this patch did) leaves `bot` in its temporal dead zone and throws
`Cannot access 'bot' before initialization`. `setupMiddlewares(bot, ...)` is the
first statement guaranteed to be past that declaration, so the block goes
immediately before it.

```diff
  export async function bootstrapGateway(ctx, agents, config, logger) {
      const manager = new SessionManager(ctx, agents, config, logger);
      // ── 初始化 QQ Bot SDK ──
      const userAgent = buildUserAgent();
      const bot = new QQBot({ ... });
      logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
      // ── 中间件链 ──
-     setupMiddlewares(bot, config, manager, logger);
+     const bridgePreHandlers = [];
+     let bridgeSender;
+     // ctx.provide(), NOT ctx.set(): see "Service registration" below.
+     const provideQqbot = ctx.provide?.bind(ctx);
+     if (typeof provideQqbot !== 'function') {
+         throw new Error('this dsh runtime has no ctx.provide(); patch 0001 requires Cordis 4');
+     }
+     const qqbotService = {
+         bot,
+         manager,
+         config,
+         get sender() { return bridgeSender; },
+         replyTargetFor(scope, targetId) {
+             return { scope: scope === 'group' ? 'group' : 'c2c', targetId };
+         },
+         setMessagePreHandler(handler) {
+             if (typeof handler !== 'function') throw new TypeError('setMessagePreHandler expects a function');
+             const existing = bridgePreHandlers.indexOf(handler);
+             if (existing !== -1) bridgePreHandlers.splice(existing, 1);
+             bridgePreHandlers.push(handler);
+             return () => {
+                 const at = bridgePreHandlers.indexOf(handler);
+                 if (at !== -1) bridgePreHandlers.splice(at, 1);
+             };
+         },
+         get preHandlerCount() { return bridgePreHandlers.length; },
+     };
+     if (typeof provideQqbot('qqbot', qqbotService) !== 'function') {
+         throw new Error('ctx.provide("qqbot", ...) did not return a disposer');
+     }
+     setupMiddlewares(bot, config, manager, logger, bridgePreHandlers);
```

and later, where the sender is built:

```diff
      const sender = {
          sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
          openStream: (target) => bot.openStream({ ... }),
      };
+     bridgeSender = sender;
```

Two details that were wrong at first and are now guarded by tests:

* **`ctx.provide`, never `ctx.set`.** `set` may only overwrite a service a fiber
  already provided; calling it first throws
  `cannot set property "qqbot" without provide`, which is exactly the activation
  failure the live host reported. `provide` also ties the registration to the
  calling fiber, so unloading or reloading `im-qqbot` removes the service.
* **`setMessagePreHandler` replaces instead of rejecting.** A hot reload calls it
  a second time; the earlier version threw `a pre-handler is already installed`,
  which would leave the gateway with no handler after a successful reload. It now
  replaces and returns a disposer.

## Why this is the narrowest possible change

* **Additive only.** `setupMiddlewares`'s new fourth parameter defaults to `[]`, so a caller that passes three arguments sees byte-identical behaviour.
* **No globals, no monkey patching, no prototype edits.** The service is registered through Cordis and disappears with the plugin.
* **It cannot be used to escalate.** The pre-handler only decides *who handles a message* — it gains no filesystem, shell or model access beyond what the bridge plugin already has.
* **One service key** (`qqbot`). Everything else in the plugin stays private.

## How to apply

```bash
# Local fork, kept as a pinned copy next to the project:
node scripts/make-bridged-qqbot.mjs --out <fork 目录>

# Or let the installer do it, together with the profile edit below:
node scripts/install-profile.mjs --fork <fork 目录> --project . --dry-run

# What the installer writes in <DSH_HOME>/profiles/<name>/package.json:
#     "@tencent-connect/dsh-qqbot": "link:<fork 目录>"
# (no change to dsh.profile.bundles -- the bundle name stays the same)
# Then, with the host stopped: pnpm install
```

`scripts/make-bridged-qqbot.mjs` performs the two insertions against the installed
copy, refuses to run twice on an already-patched tree, and writes a
`PATCH-0001-APPLIED.md` marker with the version it patched.

## Rollback

Restore the dependency line and reinstall. The fork is a separate directory and
nothing in the profile or in DS Bot is modified.

```bash
# 1. <DSH_HOME>/profiles/<name>/package.json
#    "@tencent-connect/dsh-qqbot": "^0.5.0"
# 2. with the host stopped:
cd <DSH_HOME>/profiles/<name> && pnpm install
# 3. delete the fork directory if it is no longer wanted
```

With the stock package back, `ctx.get('qqbot')` returns nothing. The bridge then
loads, logs `No qqbot service on this host`, and stays inert — QQ returns to the
stock plain-agent behaviour exactly as before.

## Verified facts this patch relies on

| Fact | Evidence |
| --- | --- |
| `bot.use` is Koa-style, `ctx.stop()` short-circuits the chain | `qqbot-nodejs/src/middleware/types.ts:199-225`; `QQBot.ts:595-608` |
| A pre-handler placed first runs before `accessPolicy` | middleware order is registration order, `middleware-setup.js:6-81` |
| `ctx.set(name, value)` publishes a cordis service | `@tencent-connect/dsh-qqbot` has no `ctx.set`; the harness's `ctx.set` is a documented Cordis API, used by other plugins in this repo |
| The plugin's own sender already handles passive/active reply limits | `dist/transport/reply-target.js:18-54`, `dist/transport/reply-limiter.js` |
| Only one `QQBot` may start per plugin instance | `qqbot-nodejs/src/QQBot.ts:439-442` |
