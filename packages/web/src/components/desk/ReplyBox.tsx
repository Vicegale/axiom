import type { DeskThread } from "../../api";

export interface ReplyBoxProps {
  topicSlug: string;
  thread: DeskThread | null;
  threads: DeskThread[];
  onSent: () => void;
  onClose: () => void;
}

/** STUB: D3 replaces this file with the real reply box. */
export function ReplyBox({ onClose }: ReplyBoxProps) {
  return (
    <div className="dk-replybox">
      <p>Replying arrives with D3.</p>
      <button type="button" className="btn ghost" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
