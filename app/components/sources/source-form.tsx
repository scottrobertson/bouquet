import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  PROBE_INTERVAL_OPTIONS,
  PROBE_TIMEOUT_OPTIONS,
  SYNC_INTERVAL_OPTIONS,
} from "~/components/sources/source-shared";

export interface SourceFormValues {
  name: string;
  serverUrl: string;
  username: string;
  password: string;
  outputFormat: "ts" | "m3u8";
  autoImportGroups: boolean;
  syncIntervalMinutes: number;
  probeEnabled: boolean;
  probeConcurrency: number;
  probeIntervalMinutes: number;
  probeTimeoutSeconds: number;
  probeMeasureBitrate: boolean;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  status?: string;
  expiresAt?: string | null;
  maxConnections?: number | null;
}

interface SourceFormProps {
  defaults?: Partial<SourceFormValues>;
  // The provider's connection limit, shown as guidance for probe concurrency.
  maxConnections?: number | null;
  submitLabel: string;
  submitIntent: "create" | "update";
  cancelHref: string;
  fieldErrors?: Partial<Record<keyof SourceFormValues, string>>;
  testResult?: TestResult | null;
}

type TestFetcherData = {
  testResult?: TestResult;
  fieldErrors?: Partial<Record<keyof SourceFormValues, string>>;
};

export function SourceForm({
  defaults,
  maxConnections,
  submitLabel,
  submitIntent,
  cancelHref,
  fieldErrors,
  testResult,
}: SourceFormProps) {
  const navigation = useNavigation();
  const saving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === submitIntent;

  // Test runs through a fetcher so it doesn't navigate and reset the form.
  const formRef = useRef<HTMLFormElement>(null);
  const testFetcher = useFetcher<TestFetcherData>();
  const testing = testFetcher.state !== "idle";

  const liveTestResult = testFetcher.data?.testResult ?? testResult;
  const errors = testFetcher.data?.fieldErrors ?? fieldErrors;

  function runTest() {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    fd.set("intent", "test");
    testFetcher.submit(fd, { method: "post" });
  }

  // Surface the test outcome as a toast, once per distinct result.
  const lastToast = useRef<TestResult | null>(null);
  useEffect(() => {
    const result = testFetcher.data?.testResult;
    if (!result || result === lastToast.current) return;
    lastToast.current = result;
    if (result.ok) {
      toast.success("Connection ok", { description: connectionSummary(result) });
    } else {
      toast.error("Connection failed", { description: result.message });
    }
  }, [testFetcher.data]);

  return (
    <Form ref={formRef} method="post" className="max-w-lg space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          defaultValue={defaults?.name}
          placeholder="My provider"
          autoComplete="off"
        />
        {errors?.name ? (
          <p className="text-xs text-destructive">{errors.name}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="serverUrl">Server URL</Label>
        <Input
          id="serverUrl"
          name="serverUrl"
          defaultValue={defaults?.serverUrl}
          placeholder="http://example.com:8080"
          autoComplete="off"
        />
        {errors?.serverUrl ? (
          <p className="text-xs text-destructive">{errors.serverUrl}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            defaultValue={defaults?.username}
            autoComplete="off"
          />
          {errors?.username ? (
            <p className="text-xs text-destructive">{errors.username}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            defaultValue={defaults?.password}
            autoComplete="off"
          />
          {errors?.password ? (
            <p className="text-xs text-destructive">{errors.password}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="outputFormat">Output format</Label>
        <Select name="outputFormat" defaultValue={defaults?.outputFormat ?? "ts"}>
          <SelectTrigger id="outputFormat" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ts">TS (MPEG-TS)</SelectItem>
            <SelectItem value="m3u8">M3U8 (HLS)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The stream URL flavour written into the output M3U for this source's channels.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="syncIntervalMinutes">Refresh frequency</Label>
        <Select
          name="syncIntervalMinutes"
          defaultValue={String(defaults?.syncIntervalMinutes ?? 1440)}
        >
          <SelectTrigger id="syncIntervalMinutes" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYNC_INTERVAL_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How often the channels and guide refresh from the provider. "Manual
          only" never auto-syncs; you sync it by hand.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <Checkbox
          id="autoImportGroups"
          name="autoImportGroups"
          defaultChecked={defaults?.autoImportGroups ?? true}
          className="mt-0.5"
        />
        <div className="space-y-1">
          <Label htmlFor="autoImportGroups" className="font-medium">
            Auto-import new groups
          </Label>
          <p className="text-xs text-muted-foreground">
            When on, categories found on a sync start enabled. When off, new
            categories arrive disabled and you turn them on from the Categories list.
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id="probeEnabled"
            name="probeEnabled"
            defaultChecked={defaults?.probeEnabled ?? false}
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor="probeEnabled" className="font-medium">
              Probe stream quality
            </Label>
            <p className="text-xs text-muted-foreground">
              Runs ffprobe against each stream to record its resolution, frame
              rate and codecs. Only channels used in a playlist are probed.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="probeConcurrency">Concurrency</Label>
            <Input
              id="probeConcurrency"
              name="probeConcurrency"
              type="number"
              min={1}
              max={20}
              defaultValue={defaults?.probeConcurrency ?? 1}
            />
            <p className="text-xs text-muted-foreground">
              Streams probed at once.
              {maxConnections != null
                ? ` This provider allows ${maxConnections}.`
                : ""}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="probeIntervalMinutes">Frequency</Label>
            <Select
              name="probeIntervalMinutes"
              defaultValue={String(defaults?.probeIntervalMinutes ?? 1440)}
            >
              <SelectTrigger id="probeIntervalMinutes" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROBE_INTERVAL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="probeTimeoutSeconds">Read time</Label>
            <Select
              name="probeTimeoutSeconds"
              defaultValue={String(defaults?.probeTimeoutSeconds ?? 10)}
            >
              <SelectTrigger id="probeTimeoutSeconds" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROBE_TIMEOUT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Checkbox
            id="probeMeasureBitrate"
            name="probeMeasureBitrate"
            defaultChecked={defaults?.probeMeasureBitrate ?? false}
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor="probeMeasureBitrate" className="font-medium">
              Measure bitrate
            </Label>
            <p className="text-xs text-muted-foreground">
              Reads each stream for the full read time to measure its real data
              rate, the best signal of actual quality. Much slower, since it
              downloads several MB per channel instead of just the header.
            </p>
          </div>
        </div>
      </div>

      {liveTestResult ? (
        <div
          className={
            liveTestResult.ok
              ? "flex items-start gap-2 rounded-md border border-transparent bg-success/10 px-3 py-2 text-[13px] text-success"
              : "flex items-start gap-2 rounded-md border border-transparent bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          }
        >
          {liveTestResult.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            {liveTestResult.ok
              ? connectionSummary(liveTestResult)
              : liveTestResult.message}
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" name="intent" value={submitIntent} disabled={saving}>
          {saving ? "Saving..." : submitLabel}
        </Button>
        <Button
          type="button"
          onClick={runTest}
          variant="secondary"
          disabled={testing}
        >
          {testing ? "Testing..." : "Test connection"}
        </Button>
        <Button asChild variant="ghost">
          <Link to={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </Form>
  );
}

function connectionSummary(r: TestResult): string {
  const parts: string[] = [];
  if (r.status) parts.push(`Status ${r.status}`);
  if (r.expiresAt) parts.push(`Expires ${new Date(r.expiresAt).toLocaleDateString()}`);
  if (r.maxConnections != null) parts.push(`${r.maxConnections} connections`);
  return parts.length ? parts.join(" · ") : "Credentials accepted";
}
