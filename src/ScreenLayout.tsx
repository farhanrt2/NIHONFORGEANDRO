import { ReactNode, useEffect } from "react";

interface ScreenLayoutProps {
  title?: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  // Props berikut dipertahankan agar kompatibel dengan layar port desktop,
  // tapi diabaikan/diinterpretasi ulang untuk mobile (lihat komentar).
  logo?: boolean | number;
  logoCentered?: boolean;
  headerRight?: ReactNode;
  /** Lebar maksimum konten. Nilai > viewport diklem ke 100% (anti scrollbar horizontal). */
  width?: number;
  hideScroll?: boolean;
  fillHeight?: boolean;
}

export default function ScreenLayout({
  subtitle,
  onClose,
  children,
  headerRight,
  width,
  fillHeight,
}: ScreenLayoutProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="nf-screen">
      {/* Header kompak: tombol kembali + judul + info kanan */}
      <div className="m-topbar">
        <button className="nf-btn nf-btn-neon nf-btn-sm m-back" onClick={onClose}>
          ←
        </button>
        {subtitle && <div className="m-title">{subtitle}</div>}
        <div className="m-topright">{headerRight}</div>
      </div>

      {/* Konten: flex-1 + min-height 0 agar tidak mendorong halaman. */}
      <div
        className="m-content"
        style={
          fillHeight
            ? { flex: "1 1 auto", display: "flex", flexDirection: "column" }
            : undefined
        }
      >
        <div
          className="m-inner"
          style={{ maxWidth: width && width < 760 ? width : "100%" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
