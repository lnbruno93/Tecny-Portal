/**
 * BarcodeScanner — modal full-screen para escanear códigos de barras (IMEI,
 * QR, EAN/UPC) con la cámara del dispositivo.
 *
 * Usa @zxing/browser (BrowserMultiFormatReader) — librería madura que soporta
 * Code128 (formato típico de IMEI), QR, EAN-13, UPC-A, etc. Detección continua:
 * cada scan exitoso dispara `onScan(text)`. El modal queda abierto para scans
 * sucesivos hasta que el usuario presione "Cerrar".
 *
 * Modo mobile-first: cámara trasera por default (`facingMode: 'environment'`).
 * Vibración + beep al detectar (UX feedback sin tener que mirar la pantalla).
 */
import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Icons } from './Icons';
import useModal from '../lib/useModal';

// Beep corto generado con WebAudio API. No hace falta servir un archivo .mp3 ni
// pedir permisos extra — el AudioContext se crea cuando el usuario interactúa
// con la página (autoplay policy ok).
function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880; // A5
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    // Cerrar el context tras el beep para no dejar audio "vivo".
    setTimeout(() => ctx.close().catch(() => {}), 200);
  } catch {
    // Si falla audio (Safari sin user-gesture, etc.) seguimos — el feedback
    // visual + vibration alcanza.
  }
}

function vibrateOk() {
  if (navigator.vibrate) navigator.vibrate(60);
}

export default function BarcodeScanner({ open, onScan, onClose, ignoreCodes }) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null); // handle para detener la cámara
  const lastScanRef = useRef({ code: null, at: 0 });
  // Set de códigos a ignorar (los ya cargados). Lo guardamos en ref para que
  // los closures dentro del callback de zxing siempre vean la versión actual
  // sin necesidad de re-iniciar la cámara cada vez que el usuario agrega uno.
  const ignoreRef = useRef(new Set());
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  // Auditoría 2026-06-30 F-10: useModal para Esc cierra, focus trap, body lock.
  // Modal full-screen sin form de cierre por click-outside (sería frustrante en
  // mobile con la cámara activa — el operador apunta a un código y un toque al
  // fondo no debe cerrar). Solo Esc + botón "Cerrar" en header.
  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });

  // Sincronizar el set con lo que viene de afuera (la lista de scaneados).
  useEffect(() => {
    ignoreRef.current = new Set(ignoreCodes || []);
  }, [ignoreCodes]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setReady(false);

    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    (async () => {
      try {
        // Pedimos la cámara trasera (environment). Si no hay, el browser
        // elige la disponible automáticamente.
        const constraints = {
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1280 },
            height: { ideal: 720 },
          },
        };
        const controls = await reader.decodeFromConstraints(
          constraints,
          videoRef.current,
          (result, err) => {
            if (cancelled) return;
            if (!result) return; // err es esperado entre frames sin código
            const text = result.getText();
            // Anti-rebote: el mismo código detectado en <1.5s lo ignoramos
            // (la cámara puede leerlo 10 veces seguidas si lo dejamos quieto).
            const now = Date.now();
            if (text === lastScanRef.current.code && now - lastScanRef.current.at < 1500) {
              return;
            }
            // Ignorar duplicados que ya están en la lista del padre.
            if (ignoreRef.current.has(text)) {
              // Beep distinto / no beep — feedback de "ya está", no de éxito.
              if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
              return;
            }
            lastScanRef.current = { code: text, at: now };
            playBeep();
            vibrateOk();
            onScan(text);
          }
        );
        if (cancelled) {
          // Si el modal se cerró mientras pedíamos permisos.
          controls?.stop?.();
          return;
        }
        controlsRef.current = controls;
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        // Errores comunes: NotAllowedError (permiso negado), NotFoundError
        // (no hay cámara), NotReadableError (otra app la tiene tomada).
        let msg = 'No se pudo acceder a la cámara.';
        if (e?.name === 'NotAllowedError') {
          msg = 'Diste "no" al permiso de cámara. Activá el acceso desde la configuración del navegador y reintentá.';
        } else if (e?.name === 'NotFoundError') {
          msg = 'No se detectó cámara en este dispositivo.';
        } else if (e?.name === 'NotReadableError') {
          msg = 'La cámara está siendo usada por otra app. Cerrala y reintentá.';
        }
        setError(msg);
      }
    })();

    return () => {
      cancelled = true;
      try { controlsRef.current?.stop?.(); } catch {}
      controlsRef.current = null;
      readerRef.current = null;
    };
  }, [open, onScan]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      style={{ background: 'rgba(0,0,0,0.92)', padding: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Escanear código de barras"
    >
      <div style={{
        position: 'relative',
        width: '100%',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header con botón cerrar */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'env(safe-area-inset-top, 12px) 16px 12px',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.6), transparent)',
          color: 'white',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {ready ? 'Apuntá al código de barras' : 'Iniciando cámara…'}
          </div>
          <button
            className="btn"
            onClick={onClose}
            aria-label="Cerrar scanner"
            style={{ background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)' }}
          >
            <Icons.X size={16} /> Cerrar
          </button>
        </div>

        {/* Video */}
        <video
          ref={videoRef}
          style={{
            flex: 1, width: '100%', height: '100%',
            objectFit: 'cover', background: 'black',
          }}
          playsInline
          muted
        />

        {/* Marco de mira (visual guide) */}
        {ready && !error && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{
              width: 'min(80vw, 320px)',
              height: 'min(35vw, 140px)',
              border: '3px solid rgba(255,255,255,0.85)',
              borderRadius: 12,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
            }} />
          </div>
        )}

        {/* Footer con instrucciones / error */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 2,
          padding: '16px 20px env(safe-area-inset-bottom, 16px)',
          background: 'linear-gradient(0deg, rgba(0,0,0,0.7), transparent)',
          color: 'white',
          textAlign: 'center',
          fontSize: 13,
        }}>
          {error
            ? <div style={{ color: '#ffb4b4', fontWeight: 600 }}>{error}</div>
            : ready
              ? <div>Mantené el código dentro del marco. Cada scan suma un IMEI.</div>
              : <div>Permitiendo acceso a la cámara…</div>
          }
        </div>
      </div>
    </div>
  );
}
