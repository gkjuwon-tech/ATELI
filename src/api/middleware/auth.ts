import type { MiddlewareHandler } from "hono";
import { hasScope, resolveToken, type Scope } from "../../storage/tokens.js";

declare module "hono" {
  interface ContextVariableMap {
    auth: { user_id: string; id: string; scope: Scope } | null;
  }
}

/**
 * Bearer-token middleware. Anonymous requests are allowed through with
 * `auth=null`; downstream routes can decide whether to reject. Setting
 * `ATELI_REQUIRE_AUTH=1` flips that to 401 by default.
 */
export const auth =
  (opts: { require?: boolean; scope?: Scope } = {}): MiddlewareHandler =>
  async (c, next) => {
    const required = opts.require ?? process.env.ATELI_REQUIRE_AUTH === "1";
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
      if (required) return c.json({ error: "unauthorized" }, 401);
      c.set("auth", null);
      return next();
    }
    const tok = resolveToken(m[1]!);
    if (!tok) return c.json({ error: "invalid_token" }, 401);
    const needed: Scope = opts.scope ?? "read";
    if (!hasScope(tok.scope, needed)) {
      return c.json({ error: "insufficient_scope", required: needed }, 403);
    }
    c.set("auth", tok);
    return next();
  };
