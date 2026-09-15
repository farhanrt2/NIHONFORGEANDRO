// ===================================================================
// Logo.tsx - Menampilkan file gambar logo NihonForge.
// Cukup ganti file di src/assets/, semua layar otomatis ikut berubah.
// Pakai: <Logo size={90} />
// ===================================================================

import logoImg from "./assets/LOGO.png";

interface LogoProps {
  size?: number;
}

export default function Logo({ size = 90 }: LogoProps) {
  return (
    <img
      src={logoImg}
      alt="NihonForge"
      width={size}
      height={size}
      className="logo-glow"
      style={{ objectFit: "contain" }}
    />
  );
}