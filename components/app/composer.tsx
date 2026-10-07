"use client";

import { useActionState, useRef, useState } from "react";
import {
  ArrowUp,
  Boxes,
  CornerDownLeft,
  Cpu,
  FlaskConical,
  Gauge,
  Globe,
  Loader2,
  Route,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd, btn } from "@/components/kit";
import { createRunAction, type CreateRunState } from "@/app/actions/runs";
import type { RunOptionsDTO } from "@/lib/ai/options";

const EXAMPLES = [
  "A CRM for freelance photographers",
  "A habit tracker with streaks and reminders",
  "An invoice generator for freelancers",
  "A waitlist page with referral tracking",
];

const STEPS = ["research", "spec", "you approve", "build", "deploy", "verify"];

/* One mark per provider. The cluster row carries it, and so does the MODEL
   button once a specific model is chosen — a glance tells you whose weights
   will build the product. */
const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  truemodel: <Zap className="h-3.5 w-3.5" />,
  hcnsec: <ShieldCheck className="h-3.5 w-3.5" />,
  aionlabs: <FlaskConical className="h-3.5 w-3.5" />,
  gemini: <Sparkles className="h-3.5 w-3.5" />,
  nvidia: <Cpu className="h-3.5 w-3.5" />,
  cerebras: <Boxes className="h-3.5 w-3.5" />,
  openrouter: <Route className="h-3.5 w-3.5" />,
  groq: <Gauge className="h-3.5 w-3.5" />,
};

/* The composer is the product's front door. It does four jobs now: take one
   sentence, let the user pick the model and the search engine (or say nothing
   and let the system choose the fastest), teach what happens to the sentence,
   and get out of the way.

   The pickers are deliberately collapsed to a single line by default. The
   automatic path is the recommended one — a user who does not care should never
   have to make a decision — so the controls only unfold when asked for. */
export function Composer({ options }: { options: RunOptionsDTO }) {
  const [state, formAction, pending] = useActionState<CreateRunState, FormData>(createRunAction, {});
  const [sentence, setSentence] = useState("");
  const [focused, setFocused] = useState(false);
  const [model, setModel] = useState<string>(""); // "" = automatic
  const [search, setSearch] = useState<string>(""); // "" = automatic
  const [open, setOpen] = useState<"none" | "model" | "search">("none");
  const formRef = useRef<HTMLFormElement>(null);
  const len = sentence.trim().length;
  const ready = len >= 10 && len <= 200;

  const chosenModel = options.models.find((m) => m.id === model);
  const chosenSearch = options.search.find((s) => s.id === search);
  const modelIcon = chosenModel ? (PROVIDER_ICONS[chosenModel.provider] ?? <Boxes className="h-3.5 w-3.5" />) : null;

  return (
    <section
      id="compose"
      className={cn(
        "scroll-mt-24 rounded-[16px] p-[1px] transition-colors duration-300",
        focused
          ? "bg-[conic-gradient(from_140deg_at_50%_50%,rgba(124,122,255,0.75),rgba(76,201,240,0.45),rgba(124,122,255,0.75))] shadow-[0_0_50px_-16px_rgba(124,122,255,0.6)]"
          : "bg-edge",
      )}
    >
      <div className="rounded-[15px] bg-[linear-gradient(180deg,rgba(255,255,255,0.03),transparent_90px),var(--app-surface)] shadow-[0_24px_60px_-36px_rgba(0,0,0,0.9)]">
        <form ref={formRef} action={formAction}>
          {/* the two choices ride along as hidden fields — the visible controls
              below are just the picker UI */}
          <input type="hidden" name="model" value={model} />
          <input type="hidden" name="search" value={search} />

          <div className="flex items-start gap-3 px-4 pt-4 md:px-5">
            <span
              className={cn(
                "mt-[3px] flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border transition-colors",
                focused ? "border-brand/40 bg-brand/15 text-brand" : "border-edge bg-surface2 text-t3",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <label htmlFor="sentence" className="eyebrow eyebrow-strong">
                What should the pipeline build?
              </label>
              <textarea
                id="sentence"
                name="sentence"
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                rows={2}
                maxLength={200}
                required
                placeholder="a CRM for freelance photographers"
                className="mt-2 w-full resize-none bg-transparent pr-2 text-[19px] font-medium leading-snug tracking-[-0.015em] text-t1 outline-none placeholder:text-t3 md:text-[21px]"
              />
            </div>
          </div>

          {state.error ? (
            <p
              role="alert"
              className="mx-4 mb-2 rounded-[10px] border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad md:mx-5"
            >
              {state.error}
            </p>
          ) : null}

          {/* ————— the run's two choices ————— */}
          <div className="border-t border-edge px-4 py-2.5 md:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <PickerButton
                icon={modelIcon ?? <Cpu className="h-3.5 w-3.5" />}
                label="Model"
                value={chosenModel ? chosenModel.model : "automatic — fastest verified"}
                active={open === "model"}
                onClick={() => setOpen(open === "model" ? "none" : "model")}
              />
              <PickerButton
                icon={<Globe className="h-3.5 w-3.5" />}
                label="Search"
                value={chosenSearch ? chosenSearch.label : "automatic chain"}
                active={open === "search"}
                onClick={() => setOpen(open === "search" ? "none" : "search")}
              />
              {!model && !search ? (
                <span className="flex items-center gap-1.5 text-[11px] text-t3">
                  <Zap className="h-3 w-3 text-brand" />
                  we pick the fastest model and the first search engine that answers
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setModel("");
                    setSearch("");
                  }}
                  className="text-[11px] text-t3 underline decoration-dotted underline-offset-2 transition-colors hover:text-t2"
                >
                  reset to automatic
                </button>
              )}
            </div>

            {open === "model" ? (
              <ChoicePanel
                title="Free models, fastest first"
                note={
                  options.automaticModel
                    ? `Automatic leads with ${options.automaticModel} and falls through the rest if it fails.`
                    : "Automatic leads with the first model and falls through the rest if it fails."
                }
              >
                <Choice
                  selected={model === ""}
                  onClick={() => {
                    setModel("");
                    setOpen("none");
                  }}
                  primary="Automatic"
                  secondary="the fastest model that answers"
                />
                {options.groups.map((g) => (
                  <ProviderCluster
                    key={g.provider}
                    group={g}
                    selectedId={model}
                    onPick={(qualified) => {
                      setModel(qualified);
                      setOpen("none");
                    }}
                  />
                ))}
                {options.models.length === 0 ? (
                  <p className="px-3 py-2 text-[11.5px] text-t3">
                    No model is configured for this plan yet — the run will still start and report what
                    is missing.
                  </p>
                ) : null}
              </ChoicePanel>
            ) : null}

            {open === "search" ? (
              <ChoicePanel
                title="Where the Research Agent looks"
                note="Whatever you pick, the rest of the chain stays behind it — search is never a single point of failure."
              >
                <Choice
                  selected={search === ""}
                  onClick={() => {
                    setSearch("");
                    setOpen("none");
                  }}
                  primary="Automatic chain"
                  secondary="Tavily → Exa → DuckDuckGo → Wikipedia"
                />
                {options.search.map((s) => (
                  <Choice
                    key={s.id}
                    selected={search === s.id}
                    onClick={() => {
                      setSearch(s.id);
                      setOpen("none");
                    }}
                    primary={s.label}
                    secondary={
                      s.keyless
                        ? "no key needed — always available"
                        : s.configured
                          ? "key configured"
                          : "no key — will be skipped"
                    }
                    dim={!s.keyless && !s.configured}
                  />
                ))}
              </ChoicePanel>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 md:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {EXAMPLES.slice(0, 3).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setSentence(ex)}
                  className="rounded-full border border-edge bg-surface2 px-2.5 py-1 text-[11.5px] text-t3 transition-colors hover:border-brand/30 hover:bg-brand/10 hover:text-t1"
                >
                  {ex.replace(/^A /, "")}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span className="tnum hidden font-mono text-[10.5px] text-t3 sm:inline">{len}/200</span>
              <span className="hidden items-center gap-1 text-[11px] text-t3 md:flex">
                <Kbd>
                  <CornerDownLeft className="h-2.5 w-2.5" />
                </Kbd>
                to start
              </span>
              <button type="submit" disabled={pending || !ready} className={btn("brand", "md", "pr-3")}>
                {pending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Starting
                  </>
                ) : (
                  <>
                    Run the pipeline
                    <ArrowUp className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* what happens to that sentence — the pipeline, before you commit */}
        <div className="flex items-center gap-0 overflow-x-auto border-t border-edge px-4 py-2.5 md:px-5">
          {STEPS.map((s, i) => (
            <div key={s} className="flex shrink-0 items-center">
              {i > 0 ? <span className="mx-1.5 h-px w-3 bg-edge2" /> : null}
              <span
                className={cn(
                  "font-mono text-[9.5px] uppercase tracking-[0.14em]",
                  s === "you approve" ? "text-warn" : s === "verify" ? "text-pass" : "text-t3",
                )}
              >
                {String(i + 1).padStart(2, "0")} {s}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PickerButton({
  icon,
  label,
  value,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "flex max-w-full items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors",
        active
          ? "border-brand/40 bg-brand/12"
          : "border-edge bg-surface2/60 hover:border-edge2",
      )}
    >
      <span className={active ? "text-brand" : "text-t3"}>{icon}</span>
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-t3">{label}</span>
      <span className="truncate text-[12px] text-t1">{value}</span>
    </button>
  );
}

function ChoicePanel({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2.5 overflow-hidden rounded-[12px] border border-edge bg-surface2/30">
      <div className="border-b border-edge px-3 py-2">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-t3">{title}</p>
        <p className="mt-1 text-[11px] leading-snug text-t3">{note}</p>
      </div>
      <div className="thin-scroll max-h-[240px] overflow-y-auto py-1">{children}</div>
    </div>
  );
}

/* One provider row that folds out to its models. Hover opens it, moving away
   closes it, clicking pins it — so a touch screen gets the same list without a
   hover. The fold-out is where the same-model-different-speed story shows:
   glm-5.3 under 1412 and glm-5.3 under HCNSEC are two rows with two numbers. */
function ProviderCluster({
  group,
  selectedId,
  onPick,
}: {
  group: RunOptionsDTO["groups"][number];
  selectedId: string;
  onPick: (qualifiedId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const chosenHere = group.models.some((m) => m.id === selectedId);
  const fastest = group.models[0];
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    if (pinned) return;
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };

  return (
    <div
      onMouseEnter={enter}
      onMouseLeave={leave}
      className={cn(open && "bg-surface2/40")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setPinned(!open);
          setOpen(!open);
        }}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
          chosenHere ? "text-t1" : "text-t2 hover:text-t1",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border",
            chosenHere ? "border-brand/40 bg-brand/15 text-brand" : "border-edge bg-surface2 text-t3",
          )}
        >
          {PROVIDER_ICONS[group.provider] ?? <Boxes className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium">{group.providerLabel}</span>
          <span className="mt-0.5 block truncate text-[10.5px] text-t3">
            {group.models.length} model{group.models.length === 1 ? "" : "s"}
            {fastest ? " · fastest " + fastest.model + (fastest.note ? " · " + fastest.note : "") : ""}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[9px] tracking-[0.12em] text-t3 transition-transform",
            open && "rotate-90",
          )}
        >
          ▸
        </span>
      </button>
      {open ? (
        <div className="border-t border-edge/60 pl-4">
          {group.models.map((m) => (
            <Choice
              key={m.id}
              selected={selectedId === m.id}
              onClick={() => onPick(m.id)}
              primary={m.model}
              secondary={m.note ?? m.providerLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Choice({
  selected,
  onClick,
  primary,
  secondary,
  dim,
}: {
  selected: boolean;
  onClick: () => void;
  primary: string;
  secondary: string;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors",
        selected ? "bg-brand/12" : "hover:bg-surface2",
        dim && !selected ? "opacity-55" : "",
      )}
    >
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-mono text-[11.5px]",
            selected ? "text-brand" : "text-t1",
          )}
        >
          {primary}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-t3">{secondary}</span>
      </span>
      {selected ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /> : null}
    </button>
  );
}
