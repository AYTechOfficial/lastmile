/* Scope discipline — accounts are opt-in by evidence in the idea, never a
   default. A tic-tac-toe or a flappy bird must not grow a login screen; a CRM
   or a multiplayer board should. The same three predicates gate flows, routes,
   the data model and the master prompt so every stage agrees on the scope. */

const AUTH_HINTS =
  /\b(multi[- ]?player|teams?|teammates?|invit\w*|shar(?:e|ed|ing)|collab\w*|members?|organi[sz]\w*|workspace|workspaces|crm|saas|multi-?user|accounts?|log[- ]?in|logins?|sign[- ]?in|sign[- ]?up|signups?|auth\w*|social|network|communit\w*|forums?|chat\w*|messag\w*|marketplace|profiles?|followers|subscribers?|bookings?|appointments?|users?|leaderboard)\b/i;

const TEAM_HINTS =
  /\b(teams?|teammates?|invit\w*|collab\w*|members?|shar(?:e|ed|ing)|multiplayer|multi[- ]?player)\b/i;

const PAY_HINTS =
  /\b(pay\w*|payments?|billing|subscriptions?|pricing|checkout|cart|invoices?|money)\b/i;

/** The idea implies user accounts (multi-user, sign-in, shared data). */
export function needsAccounts(idea: string): boolean {
  return AUTH_HINTS.test(idea);
}

/** The idea implies inviting/collaborating with other people. */
export function wantsTeams(idea: string): boolean {
  return TEAM_HINTS.test(idea);
}

/** The idea implies a payment or billing surface (a stub at most). */
export function wantsPayments(idea: string): boolean {
  return PAY_HINTS.test(idea);
}

/** Flow names that smuggle auth into products that should not have it. */
const AUTH_FLOW = /\b(sign[- ]?up|sign[- ]?in|login|log[- ]?in|auth|account|register)\b/i;
const INVITE_FLOW = /\b(invite|teammate|member|collab|share)\b/i;
const PAY_FLOW = /\b(pay|checkout|billing|subscri|invoice)\b/i;

/** Strip flows the product's scope does not justify. */
export function sanitizeFlows<T extends { name: string }>(flows: T[], idea: string): T[] {
  const accounts = needsAccounts(idea);
  const teams = wantsTeams(idea);
  const pay = wantsPayments(idea);
  return flows.filter((f) => {
    const name = f.name.toLowerCase();
    if (!accounts && AUTH_FLOW.test(name)) return false;
    if (!teams && INVITE_FLOW.test(name)) return false;
    if (!pay && PAY_FLOW.test(name)) return false;
    return true;
  });
}
