import type { ReactNode } from "react";

/** Standard page header: title, optional description, optional right-side actions. */
export function PageHeader({
  title,
  description,
  actions,
  actionsClassName,
  border = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  actionsClassName?: string;
  border?: boolean;
}) {
  return (
    <div
      className={
        "flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 md:px-8 md:py-5" +
        (border ? " border-b border-border" : "")
      }
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className={actionsClassName ?? "flex flex-wrap items-center gap-2"}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
