/* Web-search credential availability, for the shell and Settings.

   It asks the credential layer instead of reading an environment variable,
   because the product's rule is user's own key → platform default → nothing:
   a user who pasted their own Tavily key must see it configured, and a user
   riding the operator's must see that instead.

   The row's details come from `SERVICES`, so where to get a key and which env
   var holds it are stated once for the whole product rather than repeated here.

   These rows report whether the *credential* resolves. The search agent itself
   is not written yet, so this is capacity on hand — no synthetic "keyless"
   provider is invented to make the list look complete. */

import { resolveServiceCredential, SERVICES } from "../platform/services";

export type SearchProviderState = {
  id: string;
  label: string;
  configured: boolean;
  freeTier: string;
  /** where the platform default lives, shown as a paste target */
  keyEnv: string | null;
  signupUrl: string | null;
};

const FREE_TIER_NOTE = "1,000 credits/month free, no card";

export async function searchProviderStates(
  userId?: string | null,
): Promise<SearchProviderState[]> {
  const defs = SERVICES.filter((s) => s.id === "search");

  return Promise.all(
    defs.map(async (s) => {
      const { value } = await resolveServiceCredential(userId ?? null, s.id);
      return {
        id: s.id,
        label: s.label,
        configured: Boolean(value),
        freeTier: FREE_TIER_NOTE,
        keyEnv: s.envVar,
        signupUrl: s.keysUrl,
      };
    }),
  );
}
