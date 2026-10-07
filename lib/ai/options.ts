/* The run-start options — the shared shape between the server action that
   computes them and the composer that renders them.

   Kept dependency-free (type-only) so the client bundle never drags in the
   model layer: the composer imports this file, and this file imports nothing
   that touches a database or a provider. */

export type ModelOption = {
  id: string;
  provider: string;
  providerLabel: string;
  /** measured speed/latency one-liner, when the catalog has one */
  note?: string;
};

export type SearchOption = {
  id: string;
  label: string;
  configured: boolean;
  keyless: boolean;
};

export type RunOptionsDTO = {
  models: ModelOption[];
  search: SearchOption[];
  plan: string;
  /** the model "automatic" would lead with — shown so the user knows the default */
  automaticModel: string | null;
};