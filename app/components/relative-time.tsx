import { relativeTime } from "~/components/sources/source-shared";

// A short "5m ago". The server works out the wording when it renders the page
// and the browser works it out again a moment later, so the two don't always
// land on the same minute. suppressHydrationWarning tells React to live with
// that rather than treat the page as broken and re-render all of it.
export function RelativeTime({ date }: { date: Date | string | null }) {
  return <span suppressHydrationWarning>{relativeTime(date)}</span>;
}
