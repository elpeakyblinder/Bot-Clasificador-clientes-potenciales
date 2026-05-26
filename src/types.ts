export interface Lead {
  id: number | null;
  created_at: string;
  raw_text: string;
  decision: string;
  reason: string;
  username: string;
}
