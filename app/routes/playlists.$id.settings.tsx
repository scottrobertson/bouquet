import { eq } from "drizzle-orm";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, redirect } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader } from "~/components/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { db } from "~/db/index.server";
import { playlists } from "~/db/schema";
import { getPlaylist } from "~/services/playlist/queries.server";
import type { Route } from "./+types/playlists.$id.settings";

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });

  const origin = new URL(request.url).origin;
  return {
    playlist: { id: playlist.id, name: playlist.name },
    m3uUrl: `${origin}/output/m3u/${playlist.outputToken}`,
    epgUrl: `${origin}/output/epg/${playlist.outputToken}`,
  };
}

const nameSchema = z.string().trim().min(1, "Name is required");

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  if (!getPlaylist(id)) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "renamePlaylist") {
    const parsed = nameSchema.safeParse(form.get("name"));
    if (!parsed.success) {
      return data({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    db.update(playlists).set({ name: parsed.data }).where(eq(playlists.id, id)).run();
    return data({ ok: true, intent });
  }

  if (intent === "deletePlaylist") {
    db.delete(playlists).where(eq(playlists.id, id)).run();
    return redirect("/playlists");
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function PlaylistSettings({ loaderData }: Route.ComponentProps) {
  const { playlist, m3uUrl, epgUrl } = loaderData;

  return (
    <div>
      <PageHeader
        title="Playlist settings"
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to={`/playlists/${playlist.id}`}>
              <ArrowLeft className="size-4" />
              Back to editor
            </Link>
          </Button>
        }
      />

      <div className="max-w-2xl space-y-8 px-8 py-6">
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Name</h2>
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="renamePlaylist" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="playlist-name" className="sr-only">
                Name
              </Label>
              <Input id="playlist-name" name="name" defaultValue={playlist.name} />
            </div>
            <Button type="submit" size="sm">
              Save
            </Button>
          </Form>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium">Output URLs</h2>
          <p className="text-[13px] text-muted-foreground">
            Put these URLs into your IPTV player. The M3U is the channel list, the EPG is the guide.
          </p>
          <div className="space-y-3">
            <CopyField label="M3U" url={m3uUrl} />
            <CopyField label="EPG (XMLTV)" url={epgUrl} />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-destructive">Danger zone</h2>
          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
            <div className="space-y-0.5">
              <p className="text-[13px] font-medium">Delete this playlist</p>
              <p className="text-xs text-muted-foreground">
                Removes all categories and channel selections. The output URLs stop working.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Form method="post">
                    <AlertDialogAction
                      type="submit"
                      name="intent"
                      value="deletePlaylist"
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </Form>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </section>
      </div>
    </div>
  );
}

function CopyField({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(`${label} URL copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input value={url} readOnly className="font-mono text-xs" />
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
