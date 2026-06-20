import { eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import { PageHeader } from "~/components/page-header";
import { SourceForm } from "~/components/sources/source-form";
import { parseSourceForm } from "~/components/sources/source-shared";
import { db } from "~/db/index.server";
import { sources } from "~/db/schema";
import { validateAccount } from "~/services/xtream/client.server";
import type { Route } from "./+types/sources.$id.edit";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Edit ${loaderData?.source.name ?? "source"} · Bouquet` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const source = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!source) throw new Response("Not found", { status: 404 });
  return {
    source: {
      name: source.name,
      serverUrl: source.serverUrl,
      username: source.username,
      password: source.password,
      outputFormat: source.outputFormat,
      autoImportGroups: source.autoImportGroups,
      syncIntervalMinutes: source.syncIntervalMinutes,
      probeEnabled: source.probeEnabled,
      probeConcurrency: source.probeConcurrency,
      probeIntervalMinutes: source.probeIntervalMinutes,
      probeTimeoutSeconds: source.probeTimeoutSeconds,
      probeMeasureBitrate: source.probeMeasureBitrate,
      probeDetectBlackScreen: source.probeDetectBlackScreen,
    },
    // Shown as guidance next to the probe concurrency field.
    maxConnections: source.lastSyncedAt ? source.maxConnections : undefined,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  const existing = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!existing) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const intent = form.get("intent");

  const parsed = parseSourceForm(form);

  if (intent === "test") {
    if (!parsed.success) {
      return data({ fieldErrors: fieldErrorsOf(parsed.error) }, { status: 400 });
    }
    const result = await validateAccount(parsed.data);
    return data({
      testResult: {
        ok: result.ok,
        message: result.message,
        status: result.status,
        expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
        maxConnections: result.maxConnections,
      },
    });
  }

  if (intent === "update") {
    if (!parsed.success) {
      return data({ fieldErrors: fieldErrorsOf(parsed.error) }, { status: 400 });
    }
    db.update(sources).set(parsed.data).where(eq(sources.id, id)).run();
    return redirect(`/sources/${id}`);
  }

  return data({ error: "Unknown action" }, { status: 400 });
}

function fieldErrorsOf(error: import("zod").ZodError) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !out[key]) out[key] = issue.message;
  }
  return out;
}

export default function SourceEdit({ loaderData, actionData, params }: Route.ComponentProps) {
  return (
    <div>
      <PageHeader title="Edit source" description="Update connection details." />
      <div className="px-4 py-5 md:px-8 md:py-6">
        <SourceForm
          defaults={loaderData.source}
          maxConnections={loaderData.maxConnections}
          submitLabel="Save changes"
          submitIntent="update"
          cancelHref={`/sources/${params.id}`}
          fieldErrors={actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined}
          testResult={actionData && "testResult" in actionData ? actionData.testResult : null}
        />
      </div>
    </div>
  );
}
