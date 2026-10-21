import { ListVideo, MoreHorizontal, Plus, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import type { PlaylistsData } from "~/api/types/PlaylistsData";
import { apiAction, apiLoad } from "~/lib/api";
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/page-header";
import { RelativeTime } from "~/components/relative-time";
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
import type { Route } from "./+types/playlists._index";

export function meta() {
  return [{ title: "Playlists · Bouquet" }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<PlaylistsData>(request);
}

type ActionResult =
  | { ok: true; intent: "delete" }
  | { ok: false; error: string };

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<ActionResult>(request);
}

export default function PlaylistsIndex({ loaderData }: Route.ComponentProps) {
  const { playlists: rows } = loaderData;

  return (
    <div>
      <PageHeader
        title="Playlists"
        description="Curated channel lists you publish to your IPTV player."
        border={false}
        actions={<NewPlaylistDialog className="w-full sm:w-auto" />}
      />
      <div className="px-4 pb-5 pt-2 md:px-8 md:py-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={ListVideo}
            title="No playlists yet"
            description="Create a playlist to start pulling channels from your sources into a curated output."
            action={<NewPlaylistDialog />}
          />
        ) : (
          <div className="-mx-4 border-y border-border bg-card md:mx-0 md:rounded-lg md:border">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <Th className="pl-4 md:pl-2">Name</Th>
                  <Th className="text-right">Categories</Th>
                  <Th className="text-right">Channels</Th>
                  <Th>Created</Th>
                  <Th className="w-10 pr-4 md:pr-2" />
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
  const fetcher = useFetcher<typeof clientAction>();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <TableRow className="border-white/5 hover:bg-white/[0.02]">
      <TableCell className="pl-4 font-medium md:pl-2">
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
        <RelativeTime date={playlist.createdAt} />
      </TableCell>
      <TableCell className="pr-4 text-right md:pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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

function NewPlaylistDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const navigation = useNavigation();
  const creating =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "create";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className={className}>
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
