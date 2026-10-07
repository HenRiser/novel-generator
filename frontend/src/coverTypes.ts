export type CoverLayout = {
  title: string;
  author: string;
  titleColor: string;
  authorColor: string;
  titlePosition: 'top' | 'center' | 'bottom';
  fontFamily: 'serif' | 'sans-serif';
  /** Percentage of the image width. */
  titleSize: number;
  authorSize: number;
};

export type CoverVersion = {
  id: string;
  media_id: string;
  parent_id?: string;
  prompt: string;
  source: { idea: string; characters: string };
  connection?: { profile_id: string; revision?: number; model: string; preset: string };
  created_at: string;
  width: number;
  height: number;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
};

export type CoverVersionInput = Omit<CoverVersion, 'id' | 'media_id' | 'created_at' | 'mime_type'>;
export type CoverAttempt = { id: string; status: 'running' | 'unknown' | 'failed'; started_at: string; error?: string };
export type CoverState = {
  connection_id?: string;
  versions: CoverVersion[];
  selected_id?: string;
  layout: CoverLayout;
  attempt?: CoverAttempt;
};
