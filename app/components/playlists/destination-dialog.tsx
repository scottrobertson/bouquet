import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

// Credentials the client never receives are omitted. Editing an S3 destination
// leaves the secret key blank; blank means "keep the stored one".
export type DestinationDTO = {
  id: number;
  name: string;
  type: "s3" | "local";
  enabled: boolean;
  m3uPath: string;
  epgPath: string;
  publicUrlBase: string | null;
  config: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    forcePathStyle?: boolean;
    prefix?: string;
    path?: string;
  };
};

export function DestinationDialog({
  destination,
  trigger,
}: {
  destination?: DestinationDTO;
  trigger: React.ReactNode;
}) {
  const editing = destination != null;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; intent?: string }>();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"s3" | "local">(destination?.type ?? "s3");

  // Close and toast once the submission comes back ok.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      setOpen(false);
      toast.success(editing ? "Destination saved" : "Destination added");
    } else if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data, editing]);

  const c = destination?.config ?? {};

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit destination" : "Add destination"}</DialogTitle>
          <DialogDescription>
            Push this playlist's M3U and EPG to external storage.
          </DialogDescription>
        </DialogHeader>

        <fetcher.Form method="post" className="space-y-4">
          <input
            type="hidden"
            name="intent"
            value={editing ? "updateDestination" : "addDestination"}
          />
          {editing ? <input type="hidden" name="id" value={destination.id} /> : null}

          <div className="space-y-2">
            <Label htmlFor="dest-name">Name</Label>
            <Input
              id="dest-name"
              name="name"
              defaultValue={destination?.name}
              placeholder="My bucket"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dest-type">Type</Label>
            <Select
              name="type"
              value={type}
              onValueChange={(v) => setType(v as "s3" | "local")}
            >
              <SelectTrigger id="dest-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="s3">S3 / S3-compatible</SelectItem>
                <SelectItem value="local">Local folder</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === "s3" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="dest-bucket">Bucket</Label>
                  <Input id="dest-bucket" name="bucket" defaultValue={c.bucket} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dest-region">Region</Label>
                  <Input
                    id="dest-region"
                    name="region"
                    defaultValue={c.region}
                    placeholder="us-east-1"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-endpoint">Endpoint</Label>
                <Input
                  id="dest-endpoint"
                  name="endpoint"
                  defaultValue={c.endpoint}
                  placeholder="Leave blank for AWS S3"
                />
                <p className="text-xs text-muted-foreground">
                  Set for R2, MinIO, Backblaze B2, Spaces, Wasabi, etc.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-key">Access key ID</Label>
                <Input id="dest-key" name="accessKeyId" defaultValue={c.accessKeyId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-secret">Secret access key</Label>
                <Input
                  id="dest-secret"
                  name="secretAccessKey"
                  type="password"
                  placeholder={editing ? "Leave blank to keep current" : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dest-prefix">Prefix</Label>
                <Input
                  id="dest-prefix"
                  name="prefix"
                  defaultValue={c.prefix}
                  placeholder="Optional, e.g. iptv/"
                />
              </div>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  name="forcePathStyle"
                  defaultChecked={c.forcePathStyle}
                  className="size-4"
                />
                Force path-style URLs (needed by MinIO and some others)
              </label>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="dest-path">Folder path</Label>
              <Input
                id="dest-path"
                name="path"
                defaultValue={c.path}
                placeholder="/data/output"
              />
              <p className="text-xs text-muted-foreground">
                A directory on the server (e.g. a mounted volume served elsewhere).
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="dest-m3u-path">M3U file path</Label>
              <Input
                id="dest-m3u-path"
                name="m3uPath"
                defaultValue={destination?.m3uPath ?? "playlist.m3u"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dest-epg-path">EPG file path</Label>
              <Input
                id="dest-epg-path"
                name="epgPath"
                defaultValue={destination?.epgPath ?? "playlist.xml"}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dest-public">Public URL base</Label>
            <Input
              id="dest-public"
              name="publicUrlBase"
              defaultValue={destination?.publicUrlBase ?? ""}
              placeholder="https://cdn.example.com/iptv"
            />
            <p className="text-xs text-muted-foreground">
              Where the uploaded files are reachable. Used for the guide link inside
              the uploaded M3U, and to show you the public URLs.
            </p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving..." : editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
