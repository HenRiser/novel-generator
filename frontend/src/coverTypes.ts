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

export type CoverStyleId = 'cinematic' | 'ink' | 'anime' | 'fantasy' | 'minimal';
export type CoverVersion = {
  id: string;
  media_id: string;
  parent_id?: string;
  style_id?: CoverStyleId;
  template_version?: number;
  text_model?: string;
  source: { idea: string; characters: string };
  connection?: { profile_id: string; revision?: number; model: string; preset: string };
  created_at: string;
  width: number;
  height: number;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
};

export type CoverVersionInput = Omit<CoverVersion, 'id' | 'media_id' | 'created_at' | 'mime_type'>;
export type CoverAttempt = { id: string; status: 'running' | 'unknown' | 'failed'; started_at: string; error?: string; requested?: 1 | 2 | 4; completed?: number };
export type CoverState = {
  connection_id?: string;
  text_connection_id?: string;
  style_id?: CoverStyleId;
  count?: 1 | 2 | 4;
  versions: CoverVersion[];
  selected_id?: string;
  layout: CoverLayout;
  attempt?: CoverAttempt;
};
