import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Upstage for Construction",
  description: "건설 현장 맥락을 바탕으로 답하는 스마트 에이전트",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
