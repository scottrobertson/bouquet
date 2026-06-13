import {
  ChevronLeft,
  Replace,
  TextCursorInput,
  Tv2,
  Type,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

type ToolField = {
  name: string;
  label: string;
  placeholder?: string;
  // Optional fields can be left blank (e.g. the "replace with" of a removal).
  optional?: boolean;
};

type Tool = {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  // The bulk action intent this tool submits.
  intent: string;
  // Text inputs the tool needs. None means it runs straight away.
  fields?: ToolField[];
};

// Add a tool here and it shows up in the Action Bar. Each maps to a bulk intent
// handled in playlists.$id.tsx.
const TOOLS: Tool[] = [
  {
    id: "prefix",
    label: "Add prefix",
    description: "Put text before every selected name.",
    icon: Type,
    intent: "bulkPrefix",
    fields: [{ name: "text", label: "Prefix", placeholder: "e.g. UK | " }],
  },
  {
    id: "suffix",
    label: "Add suffix",
    description: "Put text after every selected name.",
    icon: TextCursorInput,
    intent: "bulkSuffix",
    fields: [{ name: "text", label: "Suffix", placeholder: "e.g.  HD" }],
  },
  {
    id: "replace",
    label: "Find and replace",
    description: "Replace text in names. Leave the second box empty to remove it.",
    icon: Replace,
    intent: "bulkReplace",
    fields: [
      { name: "search", label: "Find", placeholder: "Text to find" },
      {
        name: "replace",
        label: "Replace with",
        placeholder: "Leave empty to remove",
        optional: true,
      },
    ],
  },
  {
    id: "reset-epg",
    label: "Reset EPG",
    description: "Point EPG back at each channel's source default.",
    icon: Tv2,
    intent: "bulkResetEpg",
  },
];

/** Tools menu for the Action Bar. Fieldless tools run on click; ones with fields
    open a small form in the same popover, then submit through onRun. */
export function ChannelTools({
  count,
  onRun,
}: {
  count: number;
  onRun: (intent: string, extra?: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  function reset() {
    setTool(null);
    setValues({});
  }

  function pick(t: Tool) {
    if (!t.fields?.length) {
      onRun(t.intent);
      setOpen(false);
      return;
    }
    setTool(t);
    setValues(Object.fromEntries(t.fields.map((f) => [f.name, ""])));
  }

  function apply() {
    if (!tool) return;
    const missing = tool.fields?.some(
      (f) => !f.optional && !values[f.name]?.trim(),
    );
    if (missing) return;
    onRun(tool.intent, values);
    setOpen(false);
    reset();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary">
          <Wrench className="size-4" />
          Tools
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {!tool ? (
          <div className="flex flex-col">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t)}
                className="flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-2 text-left hover:bg-accent"
              >
                <t.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-[13px]">{t.label}</span>
                  {t.description ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t.description}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="p-2">
            <button
              type="button"
              onClick={reset}
              className="mb-2 flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
              Tools
            </button>
            <div className="mb-2 text-[13px] font-medium">{tool.label}</div>
            <div className="flex flex-col gap-2.5">
              {tool.fields!.map((f, i) => (
                <div key={f.name} className="flex flex-col gap-1">
                  <Label className="text-[11px] text-muted-foreground">
                    {f.label}
                  </Label>
                  <Input
                    autoFocus={i === 0}
                    value={values[f.name] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.name]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        apply();
                      }
                    }}
                    placeholder={f.placeholder}
                    className="h-8"
                  />
                </div>
              ))}
            </div>
            <Button size="sm" className="mt-3 w-full" onClick={apply}>
              Apply to {count}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
