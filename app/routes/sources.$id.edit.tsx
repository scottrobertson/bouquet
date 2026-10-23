import type { SourceEditData } from "~/api/types/SourceEditData";
import { PageHeader } from "~/components/page-header";
import {
  SourceForm,
  type SourceFormResult,
  type SourceFormValues,
} from "~/components/sources/source-form";
import { apiAction, apiLoad } from "~/lib/api";
import type { Route } from "./+types/sources.$id.edit";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Edit ${loaderData?.source.name ?? "source"} · Bouquet` }];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const data = await apiLoad<SourceEditData>(request);
  // The server only ever stores one of the two formats.
  return { ...data, source: data.source as SourceFormValues };
}

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<SourceFormResult>(request);
}
export default function SourceEdit({ loaderData, actionData, params }: Route.ComponentProps) {
  return (
    <div>
      <PageHeader
        title="Edit source"
        description="Update connection details."
        backTo={`/sources/${params.id}`}
      />
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
