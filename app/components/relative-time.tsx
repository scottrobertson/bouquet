import { relativeTime } from "~/components/sources/source-shared";

export function RelativeTime({ date }: { date: Date | string | null }) {
  return <span>{relativeTime(date)}</span>;
}
