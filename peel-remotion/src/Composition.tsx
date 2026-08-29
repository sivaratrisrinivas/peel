import React from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type SceneId =
  | "hook"
  | "intent"
  | "execution"
  | "verification"
  | "denied"
  | "approval"
  | "proof"
  | "ship";

type Scene = {
  id: SceneId;
  start: number;
  duration: number;
  label: string;
  title: string;
  body: string;
  accent: string;
};

const FPS = 30;
const YOUTUBE_DURATION = 155;
const SOCIAL_DURATION = 30;

const COLORS = {
  ink: "#07111f",
  panel: "#0e1b2c",
  cyan: "#5ee7f7",
  blue: "#72a7ff",
  green: "#75e2a7",
  amber: "#ffc96b",
  red: "#ff7188",
  purple: "#be9cff",
  text: "#f3f7ff",
  muted: "#9db0c8",
  line: "rgba(151, 184, 220, 0.2)",
};

const LONG_SCENES: Scene[] = [
  {
    id: "hook",
    start: 0,
    duration: 12,
    label: "01 / THE PROMISE",
    title: "AI execution with a safety brake.",
    body: "Peel turns intent into a reviewable, auditable action.",
    accent: COLORS.cyan,
  },
  {
    id: "intent",
    start: 12,
    duration: 18,
    label: "02 / PLAIN-LANGUAGE INTENT",
    title: "Start with what you mean.",
    body: "The workflow builds a safe envelope before tools run.",
    accent: COLORS.blue,
  },
  {
    id: "execution",
    start: 30,
    duration: 25,
    label: "03 / REAL TOOL PATH",
    title: "Reach the real tool, inside a sandbox.",
    body: "TrueForge reaches the MCP tool, while Daytona isolates execution.",
    accent: COLORS.cyan,
  },
  {
    id: "verification",
    start: 55,
    duration: 23,
    label: "04 / VERIFICATION GATE",
    title: "Pause before the irreversible step.",
    body: "Verification is visible. The action is held until a human decides.",
    accent: COLORS.amber,
  },
  {
    id: "denied",
    start: 78,
    duration: 25,
    label: "05 / POLICY ENFORCEMENT",
    title: "Native send_email is denied.",
    body: "No SMTP side effect. The policy boundary is explicit and testable.",
    accent: COLORS.red,
  },
  {
    id: "approval",
    start: 103,
    duration: 22,
    label: "06 / FRESH APPROVAL",
    title: "Approve the exact request—or stop.",
    body: "A fresh approval is required for the requested recipient and action.",
    accent: COLORS.green,
  },
  {
    id: "proof",
    start: 125,
    duration: 20,
    label: "07 / PROOF, NOT PROMISES",
    title: "Every decision leaves a trace.",
    body: "Recipient hash, decision, and evidence make the run reviewable.",
    accent: COLORS.purple,
  },
  {
    id: "ship",
    start: 145,
    duration: 10,
    label: "08 / SHIP IT",
    title: "Build trust into the demo.",
    body: "Public repo. Qodo-reviewed PR. A short, reproducible walkthrough.",
    accent: COLORS.cyan,
  },
];

const SOCIAL_SCENES: Scene[] = [
  { ...LONG_SCENES[0], start: 0, duration: 4 },
  { ...LONG_SCENES[2], start: 4, duration: 5 },
  { ...LONG_SCENES[3], start: 9, duration: 5 },
  { ...LONG_SCENES[4], start: 14, duration: 7 },
  { ...LONG_SCENES[5], start: 21, duration: 6 },
  { ...LONG_SCENES[6], start: 27, duration: 3 },
];

const secondsToFrames = (seconds: number) => Math.round(seconds * FPS);

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const fadeIn = (frame: number, duration = 18) =>
  interpolate(frame, [0, duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

const slideIn = (frame: number, distance = 36, duration = 18) =>
  interpolate(frame, [0, duration], [distance, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

const baseText: React.CSSProperties = {
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  letterSpacing: "-0.02em",
};

const pill = (color: string): React.CSSProperties => ({
  ...baseText,
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  border: `1px solid ${color}55`,
  backgroundColor: `${color}12`,
  color,
  borderRadius: 999,
  padding: "10px 16px",
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: "0.08em",
});

const Card: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
}> = ({ children, style, accent = COLORS.cyan }) => (
  <div
    style={{
      position: "relative",
      overflow: "hidden",
      border: `1px solid ${COLORS.line}`,
      borderRadius: 24,
      background: `linear-gradient(145deg, ${COLORS.panel} 0%, #0a1626 100%)`,
      boxShadow: `0 24px 80px ${accent}12`,
      ...style,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        backgroundColor: accent,
      }}
    />
    {children}
  </div>
);

const Dot: React.FC<{ color: string; size?: number }> = ({
  color,
  size = 12,
}) => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: "50%",
      backgroundColor: color,
      boxShadow: `0 0 18px ${color}`,
    }}
  />
);

const CodeLine: React.FC<{
  children: React.ReactNode;
  color?: string;
  dim?: boolean;
}> = ({ children, color = COLORS.text, dim }) => (
  <div
    style={{
      ...baseText,
      color: dim ? COLORS.muted : color,
      fontSize: 21,
      lineHeight: 1.7,
      whiteSpace: "nowrap",
      opacity: dim ? 0.62 : 1,
    }}
  >
    {children}
  </div>
);

const WindowDots: React.FC = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Dot color={COLORS.red} size={9} />
    <Dot color={COLORS.amber} size={9} />
    <Dot color={COLORS.green} size={9} />
  </div>
);

const Chrome: React.FC<{
  scene: Scene;
  frame: number;
  vertical: boolean;
  progress: number;
}> = ({ scene, frame, vertical, progress }) => {
  const opacity = fadeIn(frame, 12);
  return (
    <div
      style={{
        ...baseText,
        position: "absolute",
        zIndex: 20,
        top: vertical ? 54 : 42,
        left: "6%",
        width: "88%",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        opacity,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: vertical ? 34 : 40,
            height: vertical ? 34 : 40,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            background: `linear-gradient(135deg, ${COLORS.cyan}, ${COLORS.blue})`,
            color: COLORS.ink,
            fontSize: vertical ? 18 : 22,
            fontWeight: 900,
          }}
        >
          P
        </div>
        <span
          style={{
            color: COLORS.text,
            fontSize: vertical ? 18 : 22,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          PEEL
        </span>
        <span style={{ color: COLORS.muted, fontSize: vertical ? 14 : 16 }}>
          / TRUSTED EXECUTION
        </span>
      </div>
      <span style={pill(scene.accent)}>
        <Dot color={scene.accent} size={8} />
        {vertical ? "DEMO" : "TRUEFORGE DEMO"}
      </span>
      <div
        style={{
          position: "absolute",
          top: vertical ? 62 : 55,
          left: 0,
          height: 2,
          width: `${progress * 100}%`,
          background: `linear-gradient(90deg, ${COLORS.cyan}, ${scene.accent})`,
          boxShadow: `0 0 16px ${scene.accent}`,
        }}
      />
    </div>
  );
};

const Background: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const drift = interpolate(frame, [0, FPS * 30], [0, vertical ? -120 : -220], {
    extrapolateRight: "extend",
  });
  const glow = interpolate(Math.sin(frame / 34), [-1, 1], [0.08, 0.2]);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          opacity: glow,
          background: `radial-gradient(circle at ${vertical ? 52 : 68}% ${vertical ? 24 : 38}%, ${COLORS.cyan} 0%, transparent 28%), radial-gradient(circle at ${vertical ? 18 : 22}% 82%, ${COLORS.purple} 0%, transparent 24%)`,
          filter: "blur(30px)",
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.3,
          backgroundImage: `linear-gradient(${COLORS.line} 1px, transparent 1px), linear-gradient(90deg, ${COLORS.line} 1px, transparent 1px)`,
          backgroundSize: vertical ? "56px 56px" : "72px 72px",
          backgroundPosition: `${drift}px ${drift / 2}px`,
          maskImage: "linear-gradient(to bottom, black, transparent 78%)",
        }}
      />
      <AbsoluteFill
        style={{
          background: "linear-gradient(180deg, transparent 0%, #07111f 94%)",
        }}
      />
    </AbsoluteFill>
  );
};

const SceneHeading: React.FC<{
  scene: Scene;
  frame: number;
  vertical: boolean;
}> = ({ scene, frame, vertical }) => {
  const opacity = fadeIn(frame, 16);
  const y = slideIn(frame, vertical ? 24 : 42, 16);
  return (
    <div
      style={{
        ...baseText,
        opacity,
        transform: `translateY(${y}px)`,
        maxWidth: vertical ? "92%" : "53%",
      }}
    >
      <div style={{ ...pill(scene.accent), marginBottom: vertical ? 20 : 24 }}>
        <span style={{ opacity: 0.7 }}>●</span>
        {scene.label}
      </div>
      <div
        style={{
          color: COLORS.text,
          fontSize: vertical ? 52 : 82,
          lineHeight: 1.03,
          fontWeight: 850,
          letterSpacing: "-0.055em",
        }}
      >
        {scene.title}
      </div>
      <div
        style={{
          marginTop: vertical ? 22 : 30,
          color: COLORS.muted,
          fontSize: vertical ? 26 : 36,
          lineHeight: 1.28,
          maxWidth: vertical ? "96%" : "85%",
        }}
      >
        {scene.body}
      </div>
    </div>
  );
};

const Caption: React.FC<{
  children: React.ReactNode;
  frame: number;
  vertical: boolean;
  color?: string;
}> = ({ children, frame, vertical, color = COLORS.text }) => (
  <div
    style={{
      ...baseText,
      position: "absolute",
      zIndex: 30,
      left: "50%",
      bottom: vertical ? 70 : 48,
      transform: `translateX(-50%) translateY(${slideIn(frame, 16, 16)}px)`,
      opacity: fadeIn(frame, 16),
      width: vertical ? "84%" : "auto",
      padding: vertical ? "14px 18px" : "12px 22px",
      border: `1px solid ${color}44`,
      borderRadius: 14,
      backgroundColor: "rgba(7, 17, 31, 0.88)",
      color,
      fontSize: vertical ? 21 : 24,
      fontWeight: 650,
      textAlign: "center",
      lineHeight: 1.3,
    }}
  >
    {children}
  </div>
);

const HookVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const scale = interpolate(frame, [0, 80], [0.82, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.2)),
  });
  return (
    <div
      style={{
        position: "absolute",
        right: vertical ? "8%" : "8%",
        top: vertical ? 790 : 230,
        width: vertical ? "84%" : "37%",
        height: vertical ? 510 : 580,
        transform: `scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      <Card accent={COLORS.cyan} style={{ height: "100%", padding: vertical ? 24 : 38 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <WindowDots />
          <span style={{ ...baseText, color: COLORS.muted, fontSize: 17 }}>
            execution-envelope.json
          </span>
        </div>
        <div
          style={{
            ...baseText,
            marginTop: vertical ? 48 : 58,
            color: COLORS.cyan,
            fontSize: vertical ? 18 : 20,
            fontWeight: 700,
            letterSpacing: "0.12em",
          }}
        >
          PROTECTED ACTION
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 16,
            color: COLORS.text,
            fontSize: vertical ? 34 : 46,
            lineHeight: 1.08,
            fontWeight: 800,
          }}
        >
          send_email
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 34,
            display: "grid",
            gap: 14,
            color: COLORS.muted,
            fontSize: vertical ? 20 : 24,
          }}
        >
          <span>tool&nbsp;&nbsp;&nbsp;&nbsp; native / irreversible</span>
          <span>policy&nbsp;&nbsp; approval_required</span>
          <span>trace&nbsp;&nbsp;&nbsp; sha256: 93a7…d21c</span>
        </div>
        <div
          style={{
            ...baseText,
            position: "absolute",
            bottom: vertical ? 28 : 42,
            left: vertical ? 24 : 38,
            right: vertical ? 24 : 38,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: 20,
            borderTop: `1px solid ${COLORS.line}`,
            color: COLORS.green,
            fontSize: vertical ? 18 : 21,
            fontWeight: 750,
          }}
        >
          <span>● guarded</span>
          <span>awaiting decision</span>
        </div>
      </Card>
    </div>
  );
};

const IntentVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const pulse = interpolate(Math.sin(frame / 12), [-1, 1], [0.7, 1]);
  return (
    <Card
      accent={COLORS.blue}
      style={{
        position: "absolute",
        right: vertical ? "7%" : "8%",
        top: vertical ? 820 : 260,
        width: vertical ? "86%" : "39%",
        padding: vertical ? 28 : 38,
        minHeight: vertical ? 470 : 490,
      }}
    >
      <div style={{ ...baseText, color: COLORS.muted, fontSize: 17 }}>
        peel › intent compiler
      </div>
      <div
        style={{
          ...baseText,
          marginTop: 38,
          color: COLORS.text,
          fontSize: vertical ? 24 : 29,
          lineHeight: 1.45,
        }}
      >
        “Send the weekly report to the finance team, but ask me before it
        leaves the sandbox.”
      </div>
      <div
        style={{
          marginTop: 34,
          display: "grid",
          gap: 13,
        }}
      >
        {[
          ["intent", "send weekly report"],
          ["scope", "finance-team.csv"],
          ["gate", "approval before side effect"],
        ].map(([key, value], index) => (
          <div
            key={key}
            style={{
              ...baseText,
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              padding: "13px 15px",
              borderRadius: 12,
              backgroundColor: `${COLORS.blue}${index === 2 ? "25" : "12"}`,
              color: index === 2 ? COLORS.blue : COLORS.muted,
              fontSize: vertical ? 18 : 20,
              opacity: interpolate(frame, [index * 12, index * 12 + 14], [0.35, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            <span>{key}</span>
            <span style={{ color: COLORS.text }}>{value}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          ...baseText,
          marginTop: 28,
          color: COLORS.blue,
          fontSize: vertical ? 18 : 20,
          fontWeight: 700,
          opacity: pulse,
        }}
      >
        ✓ envelope ready
      </div>
    </Card>
  );
};

const ExecutionVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const focus = interpolate(frame, [10, 65, 130], [0.95, 1.05, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const lineProgress = interpolate(frame, [10, 120], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        right: vertical ? "6%" : "7%",
        top: vertical ? 800 : 220,
        width: vertical ? "88%" : "41%",
        minHeight: vertical ? 520 : 610,
        transform: `scale(${focus})`,
        transformOrigin: "center center",
      }}
    >
      <Card accent={COLORS.cyan} style={{ padding: vertical ? 24 : 34 }}>
        <div
          style={{
            ...baseText,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: COLORS.muted,
            fontSize: 17,
          }}
        >
          <span>TRUEFORGE / MCP RUN</span>
          <span style={{ color: COLORS.green }}>LIVE PATH</span>
        </div>
        <div
          style={{
            marginTop: 38,
            display: "grid",
            gridTemplateColumns: "1fr 28px 1fr",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Node color={COLORS.blue} title="Intent" subtitle="compiled" />
          <Connector progress={lineProgress} color={COLORS.cyan} />
          <Node color={COLORS.cyan} title="MCP tool" subtitle="reachable" />
        </div>
        <div style={{ margin: "25px 0", height: 1, backgroundColor: COLORS.line }} />
        <div style={{ ...baseText, color: COLORS.muted, fontSize: 17 }}>
          DAYTONA SANDBOX
        </div>
        <div
          style={{
            marginTop: 15,
            padding: vertical ? 17 : 20,
            borderRadius: 15,
            backgroundColor: "#081321",
            border: `1px solid ${COLORS.green}40`,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          <CodeLine dim>$ peel run --sandbox daytona</CodeLine>
          <CodeLine color={COLORS.green}>✓ workspace isolated</CodeLine>
          <CodeLine color={COLORS.green}>✓ policy loaded: approval_gate</CodeLine>
          <CodeLine color={COLORS.amber}>… side effect paused</CodeLine>
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 25,
            display: "flex",
            justifyContent: "space-between",
            color: COLORS.cyan,
            fontSize: vertical ? 18 : 20,
            fontWeight: 700,
          }}
        >
          <span>tool resolution</span>
          <span>{Math.round(lineProgress * 100)}%</span>
        </div>
      </Card>
    </div>
  );
};

const Node: React.FC<{ color: string; title: string; subtitle: string }> = ({
  color,
  title,
  subtitle,
}) => (
  <div
    style={{
      ...baseText,
      padding: "17px 12px",
      border: `1px solid ${color}66`,
      borderRadius: 15,
      backgroundColor: `${color}12`,
      textAlign: "center",
    }}
  >
    <Dot color={color} size={9} />
    <div style={{ marginTop: 9, color: COLORS.text, fontSize: 19, fontWeight: 750 }}>
      {title}
    </div>
    <div style={{ marginTop: 4, color: COLORS.muted, fontSize: 15 }}>{subtitle}</div>
  </div>
);

const Connector: React.FC<{ progress: number; color: string }> = ({
  progress,
  color,
}) => (
  <div style={{ position: "relative", height: 4, backgroundColor: COLORS.line }}>
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: `${progress * 100}%`,
        backgroundColor: color,
        boxShadow: `0 0 15px ${color}`,
      }}
    />
  </div>
);

const VerificationVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const scale = interpolate(frame, [0, 45, 90], [0.92, 1.08, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  return (
    <div
      style={{
        position: "absolute",
        right: vertical ? "7%" : "8%",
        top: vertical ? 830 : 255,
        width: vertical ? "86%" : "38%",
        transform: `scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      <Card accent={COLORS.amber} style={{ padding: vertical ? 26 : 36 }}>
        <div style={{ ...baseText, color: COLORS.amber, fontSize: 18, fontWeight: 800 }}>
          VERIFICATION REQUIRED
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 30,
            color: COLORS.text,
            fontSize: vertical ? 28 : 35,
            fontWeight: 800,
          }}
        >
          send_email is ready
        </div>
        <div style={{ marginTop: 28, display: "grid", gap: 14 }}>
          {[
            ["recipient", "finance@example.com"],
            ["attachment", "weekly-report.pdf"],
            ["reversible", "no — approval gate"],
          ].map(([key, value]) => (
            <div
              key={key}
              style={{
                ...baseText,
                display: "flex",
                justifyContent: "space-between",
                color: COLORS.muted,
                fontSize: vertical ? 17 : 19,
              }}
            >
              <span>{key}</span>
              <span style={{ color: COLORS.text }}>{value}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 32,
            display: "flex",
            gap: 12,
            alignItems: "center",
            color: COLORS.amber,
            fontSize: vertical ? 18 : 21,
            fontWeight: 700,
          }}
        >
          <Dot color={COLORS.amber} /> paused before side effect
        </div>
      </Card>
    </div>
  );
};

const DeniedVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const zoom = interpolate(frame, [0, 45, 85], [0.9, 1.13, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const bar = interpolate(frame, [12, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        right: vertical ? "6%" : "7%",
        top: vertical ? 820 : 220,
        width: vertical ? "88%" : "41%",
        transform: `scale(${zoom})`,
        transformOrigin: "center center",
      }}
    >
      <Card accent={COLORS.red} style={{ padding: vertical ? 25 : 34 }}>
        <div style={{ ...baseText, color: COLORS.muted, fontSize: 17 }}>
          NATIVE TOOL CALL / send_email
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 35,
            display: "flex",
            alignItems: "center",
            gap: 16,
            color: COLORS.red,
            fontSize: vertical ? 30 : 38,
            fontWeight: 850,
          }}
        >
          <span style={{ fontSize: vertical ? 38 : 48 }}>×</span> DENIED
        </div>
        <div
          style={{
            marginTop: 28,
            height: 8,
            borderRadius: 99,
            backgroundColor: `${COLORS.red}18`,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${bar * 100}%`,
              backgroundColor: COLORS.red,
              boxShadow: `0 0 18px ${COLORS.red}`,
            }}
          />
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 28,
            padding: "17px 18px",
            borderRadius: 14,
            backgroundColor: `${COLORS.red}12`,
            color: COLORS.text,
            fontSize: vertical ? 18 : 21,
            lineHeight: 1.45,
          }}
        >
          Policy requires a fresh approval before this irreversible side effect.
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 24,
            display: "flex",
            justifyContent: "space-between",
            color: COLORS.muted,
            fontSize: vertical ? 17 : 19,
          }}
        >
          <span>SMTP calls</span>
          <span style={{ color: COLORS.green, fontWeight: 800 }}>0</span>
        </div>
      </Card>
    </div>
  );
};

const ApprovalVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const buttonProgress = spring({
    frame: frame - 42,
    fps: FPS,
    config: { damping: 18, stiffness: 140 },
  });
  const lift = interpolate(buttonProgress, [0, 1], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <Card
      accent={COLORS.green}
      style={{
        position: "absolute",
        right: vertical ? "7%" : "8%",
        top: vertical ? 820 : 255,
        width: vertical ? "86%" : "38%",
        padding: vertical ? 27 : 36,
      }}
    >
      <div style={{ ...baseText, color: COLORS.green, fontSize: 18, fontWeight: 800 }}>
        APPROVAL / FRESH DECISION
      </div>
      <div
        style={{
          ...baseText,
          marginTop: 30,
          color: COLORS.text,
          fontSize: vertical ? 27 : 34,
          fontWeight: 800,
          lineHeight: 1.15,
        }}
      >
        Approve this exact request?
      </div>
      <div
        style={{
          ...baseText,
          marginTop: 24,
          color: COLORS.muted,
          fontSize: vertical ? 18 : 20,
          lineHeight: 1.5,
        }}
      >
        finance@example.com
        <br />
        weekly-report.pdf
      </div>
      <div
        style={{
          ...baseText,
          marginTop: 28,
          display: "flex",
          gap: 12,
          transform: `translateY(${lift}px)`,
          opacity: clamp(buttonProgress),
        }}
      >
        <div
          style={{
            flex: 1,
            borderRadius: 12,
            padding: "14px 10px",
            textAlign: "center",
            color: COLORS.ink,
            backgroundColor: COLORS.green,
            fontSize: vertical ? 17 : 19,
            fontWeight: 850,
          }}
        >
          APPROVE
        </div>
        <div
          style={{
            flex: 1,
            borderRadius: 12,
            padding: "14px 10px",
            textAlign: "center",
            color: COLORS.muted,
            border: `1px solid ${COLORS.line}`,
            fontSize: vertical ? 17 : 19,
            fontWeight: 750,
          }}
        >
          STOP
        </div>
      </div>
    </Card>
  );
};

const ProofVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const reveal = (index: number) =>
    interpolate(frame, [index * 13, index * 13 + 16], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  return (
    <div
      style={{
        position: "absolute",
        right: vertical ? "6%" : "7%",
        top: vertical ? 790 : 200,
        width: vertical ? "88%" : "41%",
      }}
    >
      <Card accent={COLORS.purple} style={{ padding: vertical ? 24 : 34 }}>
        <div style={{ ...baseText, color: COLORS.purple, fontSize: 18, fontWeight: 800 }}>
          AUDIT TRACE / RUN 9F3C
        </div>
        <div style={{ marginTop: 28, display: "grid", gap: 14 }}>
          {[
            ["01", "recipient hash", "sha256: 93a7…d21c", COLORS.blue],
            ["02", "human decision", "approved · fresh", COLORS.green],
            ["03", "evidence", "qodo review · clean", COLORS.purple],
          ].map(([number, key, value, color], index) => (
            <div
              key={key}
              style={{
                ...baseText,
                display: "grid",
                gridTemplateColumns: "40px 1fr",
                gap: 12,
                alignItems: "center",
                padding: "16px 14px",
                borderRadius: 13,
                backgroundColor: `${color}12`,
                border: `1px solid ${color}35`,
                opacity: reveal(index),
                transform: `translateX(${(1 - reveal(index)) * 20}px)`,
              }}
            >
              <span style={{ color, fontSize: 18, fontWeight: 850 }}>{number}</span>
              <span>
                <span style={{ display: "block", color: COLORS.muted, fontSize: 16 }}>
                  {key}
                </span>
                <span style={{ display: "block", marginTop: 3, color: COLORS.text, fontSize: vertical ? 18 : 20 }}>
                  {value}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            ...baseText,
            marginTop: 25,
            color: COLORS.purple,
            fontSize: vertical ? 18 : 20,
            fontWeight: 750,
          }}
        >
          ✓ deterministic evidence bundle ready
        </div>
      </Card>
    </div>
  );
};

const ShipVisual: React.FC<{ frame: number; vertical: boolean }> = ({
  frame,
  vertical,
}) => {
  const progress = interpolate(frame, [0, 70], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <Card
      accent={COLORS.cyan}
      style={{
        position: "absolute",
        right: vertical ? "8%" : "8%",
        top: vertical ? 840 : 275,
        width: vertical ? "84%" : "36%",
        padding: vertical ? 26 : 34,
      }}
    >
      {[
        ["public repository", "github.com/sivaratrisrinivas/peel", COLORS.green],
        ["Qodo review", "10 findings resolved", COLORS.purple],
        ["demo cut", "02:35 + 00:30", COLORS.cyan],
      ].map(([key, value, color], index) => (
        <div
          key={key}
          style={{
            ...baseText,
            display: "flex",
            justifyContent: "space-between",
            gap: 20,
            padding: "15px 0",
            borderBottom: index === 2 ? "none" : `1px solid ${COLORS.line}`,
            opacity: clamp(progress * 1.5 - index * 0.18),
          }}
        >
          <span style={{ color: COLORS.muted, fontSize: vertical ? 16 : 18 }}>{key}</span>
          <span style={{ color, fontSize: vertical ? 16 : 18, fontWeight: 800 }}>{value}</span>
        </div>
      ))}
    </Card>
  );
};

const SceneVisual: React.FC<{
  scene: Scene;
  frame: number;
  vertical: boolean;
}> = ({ scene, frame, vertical }) => {
  switch (scene.id) {
    case "hook":
      return <HookVisual frame={frame} vertical={vertical} />;
    case "intent":
      return <IntentVisual frame={frame} vertical={vertical} />;
    case "execution":
      return <ExecutionVisual frame={frame} vertical={vertical} />;
    case "verification":
      return <VerificationVisual frame={frame} vertical={vertical} />;
    case "denied":
      return <DeniedVisual frame={frame} vertical={vertical} />;
    case "approval":
      return <ApprovalVisual frame={frame} vertical={vertical} />;
    case "proof":
      return <ProofVisual frame={frame} vertical={vertical} />;
    case "ship":
      return <ShipVisual frame={frame} vertical={vertical} />;
  }
};

const captionFor = (id: SceneId, vertical: boolean) => {
  const captions: Record<SceneId, string> = {
    hook: "Intent in. Evidence out.",
    intent: "The envelope is created before execution.",
    execution: "TrueForge → MCP → Daytona sandbox",
    verification: "Pause at the human decision boundary.",
    denied: "Denied means no SMTP side effect.",
    approval: "Fresh approval for the exact request.",
    proof: "Hash. Decision. Evidence.",
    ship: "A demo should be reproducible—and reviewable.",
  };
  return vertical ? captions[id].toUpperCase() : captions[id];
};

const Scene: React.FC<{
  scene: Scene;
  vertical: boolean;
  totalDuration: number;
}> = ({ scene, vertical, totalDuration }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const progress = clamp((scene.start + frame / FPS) / totalDuration);
  const zoomCue = ["execution", "verification", "denied", "approval", "proof"].includes(
    scene.id,
  );
  const zoom = zoomCue
    ? interpolate(frame, [0, 18, 45], [1.04, 1.09, 1.03], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const shiftX = zoomCue
    ? interpolate(frame, [0, 18, 45], [0, -10, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;
  return (
    <AbsoluteFill>
      <Background frame={scene.start * FPS + frame} vertical={vertical} />
      <Chrome scene={scene} frame={frame} vertical={vertical} progress={progress} />
      <div
        style={{
          position: "absolute",
          zIndex: 10,
          left: vertical ? "7%" : "6%",
          top: vertical ? 160 : 205,
          width: vertical ? "86%" : "88%",
          height: height - (vertical ? 300 : 290),
          transform: `scale(${zoom}) translateX(${shiftX}px)`,
          transformOrigin: vertical ? "50% 40%" : "48% 45%",
        }}
      >
        <SceneHeading scene={scene} frame={frame} vertical={vertical} />
        <SceneVisual scene={scene} frame={frame} vertical={vertical} />
      </div>
      <Caption frame={frame} vertical={vertical} color={scene.accent}>
        {captionFor(scene.id, vertical)}
      </Caption>
      {!vertical && (
        <div
          style={{
            ...baseText,
            position: "absolute",
            zIndex: 30,
            right: "6%",
            bottom: 51,
            color: COLORS.muted,
            fontSize: 16,
            letterSpacing: "0.08em",
          }}
        >
          {String(scene.start).padStart(3, "0")} / {String(totalDuration).padStart(3, "0")} SEC
        </div>
      )}
      <div
        style={{
          position: "absolute",
          zIndex: 30,
          left: vertical ? "7%" : "6%",
          bottom: vertical ? 32 : 51,
          color: COLORS.muted,
          fontSize: vertical ? 13 : 15,
          letterSpacing: "0.08em",
          ...baseText,
        }}
      >
        PEEL // DEMO VISUALIZATION
      </div>
      <div
        style={{
          position: "absolute",
          zIndex: 30,
          top: vertical ? 138 : 126,
          left: vertical ? "7%" : "6%",
          width: vertical ? "86%" : "88%",
          height: 1,
          backgroundColor: COLORS.line,
        }}
      />
    </AbsoluteFill>
  );
};

const DemoComposition: React.FC<{
  vertical: boolean;
  scenes: Scene[];
  totalDuration: number;
}> = ({ vertical, scenes, totalDuration }) => {
  return (
    <AbsoluteFill style={{ color: COLORS.text }}>
      {scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={secondsToFrames(scene.start)}
          durationInFrames={secondsToFrames(scene.duration)}
          premountFor={FPS}
        >
          <Scene scene={scene} vertical={vertical} totalDuration={totalDuration} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const PeelYouTube: React.FC = () => (
  <DemoComposition
    vertical={false}
    scenes={LONG_SCENES}
    totalDuration={YOUTUBE_DURATION}
  />
);

export const PeelSocial: React.FC = () => (
  <DemoComposition
    vertical={true}
    scenes={SOCIAL_SCENES}
    totalDuration={SOCIAL_DURATION}
  />
);

export const MyComposition = () => {
  return (
    <>
      <Composition
        id="PeelYouTube"
        component={PeelYouTube}
        durationInFrames={secondsToFrames(YOUTUBE_DURATION)}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="PeelSocial"
        component={PeelSocial}
        durationInFrames={secondsToFrames(SOCIAL_DURATION)}
        fps={FPS}
        width={1080}
        height={1920}
      />
    </>
  );
};
