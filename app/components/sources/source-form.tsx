import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

export interface SourceFormValues {
  name: string;
  serverUrl: string;
  username: string;
  password: string;
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
