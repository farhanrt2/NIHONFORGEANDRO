import { useEffect, useRef } from "react";

const CHARS = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン日本語勉強漢字読解言葉文法友達学生先生学校食べ物飲物猫犬花山川海空星月火水木金土日時分秒年春夏秋冬毎朝夜昼天地人大小上下左右東西南北新古父母兄弟姉妹夫婦子供男女";

interface CharParticle {
  x: number;
  y: number;
  char: string;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  fadeRate: number;
  color: string;
  glow: number;
}

export default function KanaRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let particles: CharParticle[] = [];
    let animId = 0;
    let lastSpawn = 0;

    function resize() {
      const parent = canvas.parentElement!;
      // hanya update kalau ukuran benar-benar berubah — hindari reset canvas tiap frame
      if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    }

    // ResizeObserver — tangkap perubahan ukuran parent APAPUN penyebabnya
    // (window resize, konten memendek/memanjang, dll), bukan cuma window.resize
    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas.parentElement!);

    resize();
    window.addEventListener("resize", resize);

  const COLORS = ["#4d94ff", "#2fe6e6", "#39ff14"];

    function spawn() {
      if (particles.length >= 50) return;
      const w = canvas.width;
      const chars = CHARS.split("");
      const c = COLORS[Math.floor(Math.random() * COLORS.length)];
      particles.push({
        x: Math.random() * w * 0.6,
        y: -30 - Math.random() * 100,
        char: chars[Math.floor(Math.random() * chars.length)],
        size: 12 + Math.random() * 28,
        speedX: 0.2 + Math.random() * 0.6,
        speedY: 0.3 + Math.random() * 0.7,
        opacity: 0.4 + Math.random() * 0.45,
        fadeRate: 0.0003 + Math.random() * 0.0005,
        color: c,
        glow: 8 + Math.random() * 16,
      });
    }

    function animate(time: number) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (time - lastSpawn > 800 + Math.random() * 1500) {
        spawn();
        lastSpawn = time;
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.speedX + Math.sin(time * 0.0008 + p.x * 0.01) * 0.15;
        p.y += p.speedY;
        p.opacity -= p.fadeRate;

        if (p.opacity <= 0 || p.x > w + 30 || p.y > h + 30) {
          particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = p.opacity;
        ctx.font = `bold ${p.size}px "Yu Gothic", "MS Mincho", "Noto Sans JP", sans-serif`;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.glow;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(p.char, p.x, p.y);
        ctx.restore();
      }

      animId = requestAnimationFrame(animate);
    }

    lastSpawn = performance.now();
    animId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}
