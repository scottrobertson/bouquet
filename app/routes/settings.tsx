import { AlertTriangle, Download, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Form, data, useActionData, useNavigation } from "react-router";
import { toast } from "sonner";
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
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { env } from "~/lib/env.server";
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
  type BackupInfo,
} from "~/services/backup/backup.server";
import type { Route } from "./+types/settings";

export function meta() {
  return [{ title: "Settings · Bouquet" }];
}

export function loader() {
  return {
    backups: listBackups(),
    backupsPath: env.backupsPath,
    backupCron: env.backupCron,
    backupKeep: env.backupKeep,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "backupNow") {
    const { file } = createBackup("manual");
    return data({ ok: true, intent, message: `Backup created: ${file}` });
  }

  if (intent === "deleteBackup") {
    try {
      deleteBackup(String(form.get("file") ?? ""));
      return data({ ok: true, intent, message: "Backup deleted" });
    } catch (err) {
      return data(
        { ok: false, intent, message: err instanceof Error ? err.message : "Delete failed" },
        { status: 400 },
      );
    }
  }

  if (intent === "restore") {
    try {
      restoreBackup(String(form.get("file") ?? ""));
      return data({
        ok: true,
        intent,
        message: "Restored from backup.",
      });
    } catch (err) {
      return data(
        { ok: false, intent, message: err instanceof Error ? err.message : "Restore failed" },
        { status: 400 },
      );
    }
  }

  return data({ ok: false, message: "Unknown action" }, { status: 400 });
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { backups, backupsPath, backupCron, backupKeep } = loaderData;
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const backingUp =
    nav.state !== "idle" && nav.formData?.get("intent") === "backupNow";

  // Surface the action result as a toast.
  useEffect(() => {
    if (!actionData?.message) return;
    if (actionData.ok) toast.success(actionData.message);
    else toast.error(actionData.message);
  }, [actionData]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Back up and restore your sources, categories, and playlists."
        actions={
          <Form method="post">
            <Button
              type="submit"
              name="intent"
              value="backupNow"
              size="sm"
              disabled={backingUp}
            >
              <Save className="size-4" />
              {backingUp ? "Backing up…" : "Back up now"}
            </Button>
          </Form>
        }
      />

      <div className="max-w-3xl space-y-3 px-4 py-5 md:px-8 md:py-6">
        <h2 className="text-[13px] font-medium">Backups</h2>
        <p className="text-[13px] text-muted-foreground">
          Each backup is a full snapshot of the database, gzipped, in{" "}
          <code className="rounded bg-secondary px-1 py-0.5 text-xs">{backupsPath}</code>.
          Drop a file in there and it shows up here. Auto-backups run on{" "}
          <code className="rounded bg-secondary px-1 py-0.5 text-xs">{backupCron}</code>,
          keeping the latest {backupKeep}. Restoring replaces everything; an older
          backup is upgraded to the current version as part of the restore.
        </p>

        {backups.length === 0 ? (
          <EmptyState
            icon={Save}
            title="No backups yet"
            description="Use “Back up now”, or wait for the scheduled backup."
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.map((b) => (
                  <BackupRow key={b.file} backup={b} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function versionLabel(b: BackupInfo): string {
  if (!b.valid) return "Unrecognized file";
  return b.version != null ? `Schema v${b.version}` : "—";
}

function BackupRow({ backup: b }: { backup: BackupInfo }) {
  // Older backups restore fine (they get upgraded); only newer-than-app or
  // unrecognized files are blocked.
  const restoreBlocked = !b.valid || b.isNewerThanApp;

  return (
    <TableRow className="border-white/5">
      <TableCell className="whitespace-nowrap text-muted-foreground">
        <RelativeTime date={b.createdAt ?? b.modifiedAt} />
      </TableCell>
      <TableCell>
        <Badge className="border-transparent bg-secondary text-muted-foreground">
          {b.trigger === "auto"
            ? "Scheduled"
            : b.trigger === "manual"
              ? "Manual"
              : b.trigger === "prerestore"
                ? "Pre-restore"
                : "Added"}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {versionLabel(b)}
          {b.isNewerThanApp ? (
            <span
              className="flex items-center gap-1 text-warning"
              title="From a newer version of Bouquet; update the app before restoring."
            >
              <AlertTriangle className="size-3.5" />
              newer than app
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatSize(b.size)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-0.5">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            title="Download"
          >
            <a href={`/settings/backup/${encodeURIComponent(b.file)}`} download>
              <Download className="size-4" />
            </a>
          </Button>

          <RestoreButton file={b.file} disabled={restoreBlocked} />
          <DeleteButton file={b.file} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function RestoreButton({ file, disabled }: { file: string; disabled: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          title={disabled ? "Cannot restore this file" : "Restore"}
          disabled={disabled}
        >
          <RotateCcw className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
          <AlertDialogDescription>
            This replaces all current sources, categories, and playlists with the
            contents of the backup. A safety backup of the current state is taken
            first. Afterwards, run a sync to refill the channel browser.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Form method="post">
            <input type="hidden" name="file" value={file} />
            <AlertDialogAction type="submit" name="intent" value="restore">
              Restore
            </AlertDialogAction>
          </Form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteButton({ file }: { file: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this backup file?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the file from disk. It cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Form method="post">
            <input type="hidden" name="file" value={file} />
            <AlertDialogAction
              type="submit"
              name="intent"
              value="deleteBackup"
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </Form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
