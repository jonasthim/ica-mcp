export type ToolCtx = { http?: { authInfo?: { extra?: Record<string, unknown> } } };

/**
 * The signed-in ica-hub user id for this request. Fails closed: throws if the request carries no verified user
 * (cannot happen behind requireBearerAuth, but a user-scoped tool must never run as "nobody").
 */
export const userIdOf = (ctx: ToolCtx): string => {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== 'string' || userId === '') throw new Error('no authenticated user in MCP context');
  return userId;
};
