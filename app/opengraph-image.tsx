import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "LastMile — One sentence in. A verified live product out.";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#07080b",
          backgroundImage:
            "radial-gradient(ellipse 900px 500px at 50% 30%, rgba(133,131,255,0.14), transparent 70%)",
          color: "#f5f5f7",
          position: "relative",
        }}
      >
        {/* check mark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 88,
            height: 88,
            borderRadius: 24,
            border: "2px solid rgba(133,131,255,0.5)",
            backgroundColor: "rgba(133,131,255,0.1)",
            marginBottom: 36,
          }}
        >
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 13.5 9.5 19 20 6.5"
              stroke="#8583ff"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
          }}
        >
          One sentence in.
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            marginTop: 8,
          }}
        >
          <span>A&nbsp;</span>
          <span style={{ color: "#a5a3ff", fontStyle: "italic", fontFamily: "Georgia" }}>
            verified
          </span>
          <span>&nbsp;product out.</span>
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 44,
            padding: "10px 26px",
            borderRadius: 999,
            border: "1px solid rgba(245,245,247,0.18)",
            color: "rgba(245,245,247,0.65)",
            fontSize: 20,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
          }}
        >
          lastmile — research → spec → build → deploy &amp; verify
        </div>
      </div>
    ),
    size,
  );
}
