/* The run-start options — the shared shape between the server action that
   computes them and the composer that renders them.

   Kept dependency-free (type-only) so the client bundle never drags in the
   model layer: the composer imports this file, and this file imports nothing
   that touches a database or a provider. */

export type ModelOption = {
  /** qualified choice: `provider/model` — the same model id can sit on two
      providers at different speeds, so the choice names both */
  id: string;
  /** the bare model id, as the provider itself knows it */
  model: string;
  provider: string;
  providerLabel: string;
  /** measured speed/latency one-liner, when the catalog has one */
  note?: string;
};

/** One provider cluster in the picker: the row the user hovers, and the
    models that fold out beneath it. Providers can carry the same model at
    different speeds, which is exactly why the cluster — not one flat list —
    is the unit of choice. */
export type ModelGroup = {
  provider: string;
  providerLabel: string;
  models: ModelOption[];
};

export type SearchOption = {
  id: string;
  label: string;
  configured: boolean;
  keyless: boolean;
};

export type RunOptionsDTO = {
  models: ModelOption[];
  /** the same models, clustered by provider in chain-priority order */
  groups: ModelGroup[];
  search: SearchOption[];
  plan: string;
  /** the model "automatic" would lead with — shown so the user knows the default */
  automaticModel: string | null;
};