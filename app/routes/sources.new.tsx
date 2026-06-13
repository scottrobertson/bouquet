import { data, redirect } from "react-router";
import { SourceForm } from "~/components/sources/source-form";
import { sourceSchema } from "~/components/sources/source-shared";
import { PageHeader } from "~/components/page-header";
import { db } from "~/db/index.server";
import { sources } from "~/db/schema";
import { startSync } from "~/services/sync/sync.server";
import { validateAccount } from "~/services/xtream/client.server";
import type { Route } from "./+types/sources.new";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  const parsed = sourceSchema.safeParse({
    name: form.get("name"),
    serverUrl: form.get("serverUrl"),
    username: form.get("username"),
    password: form.get("password"),
  });

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

  if (intent === "create") {
    if (!parsed.success) {
      return data({ fieldErrors: fieldErrorsOf(parsed.error) }, { status: 400 });
    }
    const created = db
      .insert(sources)
      .values({ ...parsed.data, syncStatus: "syncing" })
      .returning()
      .get();
    // Kick the catalog sync in the background and go straight to the detail
    // screen, which polls until the sync finishes.
    startSync(created.id);
    return redirect(`/sources/${created.id}`);
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

export default function SourceNew({ actionData }: Route.ComponentProps) {
  return (
    <div>
      <PageHeader
        title="Add source"
        description="Connect an Xtream Codes provider."
      />
      <div className="px-4 py-5 md:px-8 md:py-6">
        <SourceForm
          submitLabel="Create source"
          submitIntent="create"
          cancelHref="/sources"
          fieldErrors={actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined}
          testResult={actionData && "testResult" in actionData ? actionData.testResult : null}
        />
      </div>
    </div>
  );
}
