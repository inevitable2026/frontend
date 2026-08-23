import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import styles from "./demo-video.module.css";

export const metadata: Metadata = {
  title: "시연 영상 — Upstage for Construction",
  description: "현장 문서에서 위험성평가까지, 콘솔을 실제로 조작한 1분 시연 영상.",
};

// 정적으로 굳혀 둔다 — 영상 한 편과 링크뿐이라 요청마다 다시 만들 이유가 없다.
export const dynamic = "force-static";

export default function DemoVideoPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.brand}>
          <Image
            className={styles.brandMark}
            src="/assets/upstage-logo.svg"
            alt="Upstage for Construction"
            width={120}
            height={22}
            priority
          />
          <span className={styles.eyebrow}>Demo</span>
        </div>

        <h1 className={styles.title}>현장 문서에서 위험성평가까지, 1분 시연</h1>
        <p className={styles.lede}>
          메일·법령·현장 문서를 한자리에서 읽고, 바뀐 조건을 태스크 보드가 집어내고,
          위험성평가 회의록이 그 근거를 달고 다시 서기까지 — 콘솔을 실제로 조작한 화면입니다.
        </p>

        <div className={styles.frame}>
          {/* 원본에 음성 트랙이 없는 화면 녹화라 소리 조절은 두지 않는다. */}
          <video
            className={styles.video}
            src="/demo/upstage-demo.mp4"
            poster="/demo/upstage-demo-poster.jpg"
            controls
            playsInline
            preload="metadata"
            width={1512}
            height={828}
          >
            <a href="/demo/upstage-demo.mp4">시연 영상 내려받기</a>
          </video>
        </div>

        <div className={styles.meta}>
          <span>1:16</span>
          <span>1512 × 828</span>
          <span>음성 없음</span>
        </div>

        <div className={styles.actions}>
          <Link className={styles.primary} href="/">
            콘솔 직접 열어보기
          </Link>
          <a className={styles.secondary} href="/demo/upstage-demo.mp4" download>
            영상 내려받기
          </a>
        </div>
      </div>
    </main>
  );
}
