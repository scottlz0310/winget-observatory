/**
 * PR イベントタイムラインからの状態遷移シミュレーションに関する純粋ドメインロジック。
 * 外部 I/O を行わない純粋関数であり、src/models の型定義および同一ドメインの labels にのみ依存する。
 */

import type { ProgressTimelineEvent } from "../models/progress";
import { isEligibleLabels } from "./labels";

/**
 * タイムラインイベント履歴を走査し、条件成立（Ready）となった日時を特定する。
 */
export function simulateReadySince(
  events: ProgressTimelineEvent[],
  currentIsDraft: boolean,
  endAt: Date,
): Date | null {
  // 有効なイベントのみ抽出して日付昇順ソート
  const targetEvents = events
    .filter((e) =>
      ["labeled", "unlabeled", "converted_to_draft", "ready_for_review"].includes(e.event),
    )
    .filter((e) => e.created_at && !Number.isNaN(new Date(e.created_at).getTime()))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // 最初の Draft イベントから初期状態を逆算（なければ現在状態を採用）
  let isDraft = currentIsDraft;
  for (const event of targetEvents) {
    if (event.event === "ready_for_review") {
      isDraft = true;
      break;
    }
    if (event.event === "converted_to_draft") {
      isDraft = false;
      break;
    }
  }

  const labels = new Set<string>();
  let readySince: Date | null = null;
  const endTimestamp = endAt.getTime();

  for (const event of targetEvents) {
    const eventTime = new Date(event.created_at);
    if (eventTime.getTime() > endTimestamp) {
      break;
    }

    switch (event.event) {
      case "labeled": {
        if (event.label?.name) {
          labels.add(event.label.name);
        }
        break;
      }
      case "unlabeled": {
        if (event.label?.name) {
          labels.delete(event.label.name);
        }
        break;
      }
      case "converted_to_draft": {
        isDraft = true;
        break;
      }
      case "ready_for_review": {
        isDraft = false;
        break;
      }
    }

    const eligible = !isDraft && isEligibleLabels(labels);
    if (eligible) {
      if (readySince === null) {
        readySince = eventTime;
      }
    } else {
      readySince = null;
    }
  }

  return readySince;
}
