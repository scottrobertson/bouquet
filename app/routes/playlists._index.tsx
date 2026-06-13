import { eq } from "drizzle-orm";
import { ListVideo, MoreHorizontal, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, data, redirect, useFetcher, useNavigation } from "react-router";
import { nanoid } from "nanoid";
import { z } from "zod";
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/page-header";
import { relativeTime } from "~/components/sources/source-shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { db } from "~/db/index.server";
import { playlists } from "~/db/schema";
import { listPlaylists } from "~/services/playlist/queries.server";
import type { Route } from "./+types/playlists._index";

export async function loader() {
  return { playlists: listPlaylists() };
}

const nameSchema = z.string().trim().min(1, "Name is required");

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const parsed = nameSchema.safeParse(form.get("name"));
    if (!parsed.success) {
      return data({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    const created = db
      .insert(playlists)
      .values({ name: parsed.data, outputToken: nanoid() })
      .returning()
      .get();
    return redirect(`/playlists/${created.id}`);
  }

  const id = Number(form.get("id"));
  if (!Number.isFinite(id)) {
    return data({ ok: false, error: "Missing playlist" }, { status: 400 });
  }

  if (intent === "rename") {
    const parsed = nameSchema.safeParse(form.get("name"));
    if (!parsed.success) {
      return data({ ok: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    db.update(playlists).set({ name: parsed.data }).where(eq(playlists.id, id)).run();
    return data({ ok: true, intent });
  }

  if (intent === "delete") {
    db.delete(playlists).where(eq(playlists.id, id)).run();
    return data({ ok: true, intent });
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
}

export default function PlaylistsIndex({ loaderData }: Route.ComponentProps) {
  const { playlists: rows } = loaderData;

  return (
    <div>
      <PageHeader
        title="Playlists"
        description="Curated channel lists you publish to your IPTV player."
        actions={<NewPlaylistDialog />}
      />
      <div className="px-8 py-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={ListVideo}
            title="No playlists yet"
            description="Create a playlist to start pulling channels from your sources into a curated output."
            action={<NewPlaylistDialog />}
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <Th>Name</Th>
                  <Th className="text-right">Categories</Th>
                  <Th className="text-right">Channels</Th>
                  <Th>Created</Th>
                  <Th className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <PlaylistRow key={p.id} playlist={p} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

type Row = Route.ComponentProps["loaderData"]["playlists"][number];

function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <TableHead
      className={cn(
        "h-9 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function PlaylistRow({ playlist }: { playlist: Row }) {
  const fetcher = useFetcher<typeof action>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  return (
    <TableRow className="border-white/5 hover:bg-white/[0.02]">
      <TableCell className="font-medium">
        <Link to={`/playlists/${playlist.id}`} className="hover:text-primary">
          {playlist.name}
        </Link>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {playlist.categoryCount}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {playlist.channelCount}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {relativeTime(playlist.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`/playlists/${playlist.id}/settings`}>
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          playlist={playlist}
          fetcher={fetcher}
        />

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the playlist, its categories, and its channel
                selections. The output URLs stop working. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  fetcher.submit(
                    { intent: "delete", id: playlist.id },
                    { method: "post" },
                  )
                }
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  playlist,
  fetcher,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  playlist: Row;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  // Close once the rename request settles.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (fetcher.state === "submitting") wasSubmitting.current = true;
    else if (fetcher.state === "idle" && wasSubmitting.current) {
      wasSubmitting.current = false;
      if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) onOpenChange(false);
    }
  }, [fetcher.state, fetcher.data, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename playlist</DialogTitle>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="rename" />
          <input type="hidden" name="id" value={playlist.id} />
          <div className="space-y-2">
            <Label htmlFor={`rename-${playlist.id}`}>Name</Label>
            <Input
              id={`rename-${playlist.id}`}
              name="name"
              defaultValue={playlist.name}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="submit" size="sm">
              Save
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function NewPlaylistDialog() {
  const [open, setOpen] = useState(false);
  const navigation = useNavigation();
  const creating =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "create";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          New playlist
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New playlist</DialogTitle>
          <DialogDescription>
            Give it a name. You can add categories and channels next.
          </DialogDescription>
        </DialogHeader>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="create" />
          <div className="space-y-2">
            <Label htmlFor="new-playlist-name">Name</Label>
            <Input id="new-playlist-name" name="name" placeholder="e.g. Living Room" autoFocus />
          </div>
          <DialogFooter>
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
