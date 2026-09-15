// ===================================================================
// Modal.tsx - Dialog kotak dari aplikasi sendiri (bukan pop-up browser)
// Dua hook siap pakai:
//   - useConfirm()  -> tanya Ya/Tidak, mengembalikan Promise<boolean>
//   - useAlert()    -> tampilkan pesan dengan tombol OK
// Efek: fade + sedikit zoom, cepat.
// Cara pakai lihat contoh di Dictionary.tsx / AllKotoba.tsx.
// ===================================================================

import { createContext, useCallback, useContext, useState, ReactNode } from "react";

// ---------- animasi (disuntik sekali) ----------
const STYLE_ID = "nf-modal-style";
function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    @keyframes nfFadeIn { from { opacity: 0 } to { opacity: 1 } }
    @keyframes nfFadeOut { from { opacity: 1 } to { opacity: 0 } }
    @keyframes nfPop { from { transform: scale(0.92); opacity: 0 } to { transform: scale(1); opacity: 1 } }
    .nf-overlay { animation: nfFadeIn 0.12s ease both; }
    .nf-overlay.closing { animation: nfFadeOut 0.12s ease both; }
    .nf-box { animation: nfPop 0.14s ease both; }
  `;
  document.head.appendChild(el);
}

interface DialogState {
  open: boolean;
  closing: boolean;
  message: string;
  mode: "confirm" | "alert";
  resolve?: (v: boolean) => void;
}

const ModalCtx = createContext<{
  confirm: (msg: string) => Promise<boolean>;
  alert: (msg: string) => Promise<boolean>;
  isDialogOpen: boolean;
} | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  ensureStyle();
  const [state, setState] = useState<DialogState>({
    open: false,
    closing: false,
    message: "",
    mode: "confirm",
  });

  const close = useCallback((result: boolean) => {
    // mulai animasi keluar, lalu benar-benar tutup
    setState((s) => ({ ...s, closing: true }));
    setTimeout(() => {
      setState((s) => {
        s.resolve?.(result);
        return { ...s, open: false, closing: false };
      });
    }, 120);
  }, []);

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, closing: false, message, mode: "confirm", resolve });
    });
  }, []);

  const alert = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, closing: false, message, mode: "alert", resolve });
    });
  }, []);

  return (
    <ModalCtx.Provider value={{ confirm, alert, isDialogOpen: state.open }}>
      {children}
      {state.open && (
        <div
          className={"nf-overlay" + (state.closing ? " closing" : "")}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => state.mode === "alert" && close(true)}
        >
          <div
            className="nf-box"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#2f2f2f",
              border: "1px solid #666",
              borderRadius: 8,
              padding: 24,
              minWidth: 320,
              maxWidth: 440,
              boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
              color: "#fff",
            }}
          >
            <div style={{ fontSize: 17, lineHeight: 1.5, marginBottom: 20, whiteSpace: "pre-wrap" }}>
              {state.message}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              {state.mode === "confirm" && (
                <button
                  className="nf-btn"
                  style={{ background: "#555", color: "#fff", fontSize: 15, padding: "8px 18px" }}
                  onClick={() => close(false)}
                >
                  Batal
                </button>
              )}
              <button
                className="nf-btn"
                style={{
                  background: state.mode === "confirm" ? "var(--pink-strong)" : "#1a6fe0",
                  color: "#fff",
                  fontSize: 15,
                  padding: "8px 18px",
                }}
                onClick={() => close(true)}
                autoFocus
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalCtx.Provider>
  );
}

// Hook konfirmasi (Ya/Tidak)
export function useConfirm() {
  const ctx = useContext(ModalCtx);
  if (!ctx) throw new Error("ModalProvider belum dipasang");
  return ctx.confirm;
}

// Hook alert (OK saja)
export function useAlert() {
  const ctx = useContext(ModalCtx);
  if (!ctx) throw new Error("ModalProvider belum dipasang");
  return ctx.alert;
}

// Hook untuk hotkey gating — additive, backward-compatible
export function useIsDialogOpen(): boolean {
  const ctx = useContext(ModalCtx);
  if (!ctx) throw new Error("ModalProvider belum dipasang");
  return ctx.isDialogOpen;
}
