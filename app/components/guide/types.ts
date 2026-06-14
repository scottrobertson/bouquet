// Client-side guide shapes. Times are in milliseconds so the grid math can use
// them directly (the server stores seconds).

export interface ProgrammeView {
  startMs: number;
  stopMs: number;
  title: string | null;
  subTitle: string | null;
  description: string | null;
  category: string | null;
  catchup: boolean;
}

export interface ChannelView {
  displayName: string;
  logo: string;
  tvgId: string;
  catchupDays: number;
  programmes: ProgrammeView[];
}

export interface CategoryView {
  name: string;
  channels: ChannelView[];
}
