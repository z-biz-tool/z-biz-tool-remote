import { Tooltip } from "antd";
import { useStatsStore } from "../stores/statsStore";
import { t } from "../i18n";

const MODE_LABEL: Record<string, string> = {
  off: "stats.mode.off",
  relay: "stats.mode.relay",
  display: "stats.mode.display",
  canvas: "stats.mode.canvas",
};

/** 1 秒刷新一次的链路读数；帧率显示实测值，不显示"想要"的值。 */
export function StreamStatsBar({ side }: { side: "host" | "viewer" }) {
  const { stats } = useStatsStore();
  if (stats.mode === "off" && !stats.dropped) return null;
  const fps = side === "host" ? stats.outFps : stats.inFps || stats.outFps;
  const kbps = side === "host" ? stats.outKbps : stats.inKbps;
  const rtt = stats.iceRttMs ?? stats.rttMs;
  const fpsShort = stats.requestedFps > 0 && fps + 1 < stats.requestedFps;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
        padding: "4px 10px",
        fontSize: 12,
        color: "#bbb",
        background: "rgba(255,255,255,0.03)",
        borderRadius: 6,
      }}
    >
      <span>
        {t("stats.mode")}: <b style={{ color: "#4f9cff" }}>{t(MODE_LABEL[stats.mode] ?? "stats.mode.off")}</b>
      </span>
      <span>
        {t("stats.fps")}:{" "}
        <b style={{ color: fpsShort ? "#faad14" : "#d9d9d9" }}>
          {fps.toFixed(1)}
          {fpsShort ? ` / ${stats.requestedFps}` : ""}
        </b>
      </span>
      <span>
        {t("stats.bitrate")}: <b>{kbps > 1024 ? `${(kbps / 1024).toFixed(2)} Mbps` : `${kbps.toFixed(0)} kbps`}</b>
      </span>
      <span>
        {t("stats.rtt")}: <b>{rtt == null ? "—" : `${rtt} ms`}</b>
      </span>
      <span>
        {t("stats.resolution")}: <b>{stats.resolution}</b>
      </span>
      <Tooltip title={Object.entries(stats.dropReasons).map(([k, v]) => `${k}=${v}`).join("  ") || "无"}>
        <span>
          {t("stats.dropped")}: <b style={{ color: stats.dropped ? "#ff7875" : "#8c8c8c" }}>{stats.dropped}</b>
        </span>
      </Tooltip>
      {stats.backpressure && <span style={{ color: "#faad14" }}>{t("stats.backpressure")}</span>}
      {stats.mode === "relay" && stats.note && (
        <span style={{ color: "#8c8c8c" }}>{t("stats.fallback", { reason: stats.note })}</span>
      )}
    </div>
  );
}
