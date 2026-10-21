import { SourceForm, type SourceFormResult } from "~/components/sources/source-form";
import { PageHeader } from "~/components/page-header";
import { apiAction } from "~/lib/api";
import type { Route } from "./+types/sources.new";

export function meta() {
  return [{ title: "Add source · Bouquet" }];
}

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<SourceFormResult>(request);
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
