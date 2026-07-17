// useFormFields — hook mínimo para forms con validación inline (task #145).
//
// Reemplaza el patrón "solo error al submit" — user completa 10 campos,
// clickea Guardar, recién ahí ve 3 errores simultáneos → frustración +
// double roundtrip. Con este hook, el error del campo aparece al submit
// pero se limpia apenas el user empieza a corregirlo (typing feedback
// instantáneo), y el submit se bloquea si la validación local falla.
//
// API:
//   const { form, setField, setForm, fieldErrors, setFieldErrors,
//           validate, resetErrors } = useFormFields(initialForm, validator);
//
//   · `form`               → el objeto de campos actual.
//   · `setField(key, val)` → actualiza form[key] y limpia fieldErrors[key].
//   · `setForm(newForm)`   → reemplaza el form entero (para edit/reset).
//   · `fieldErrors`        → { [key]: 'mensaje' } — muestra debajo de cada input.
//   · `setFieldErrors(obj)`→ setter directo (para errores del backend con `fields`).
//   · `validate()`         → corre validator, setea fieldErrors si hay, devuelve bool.
//   · `resetErrors()`      → limpia todos los errores (útil al reabrir modal).
//
// `validator(form)` debe devolver:
//   - null    → todo OK
//   - object  → { [key]: 'mensaje' } — mismos keys que en `form`.
//
// Patrón adoptado de admin-frontend/src/pages/Novedades.jsx (task #142).
// Diferencia: allí está inline, acá extraído para reusar en frontend/.
//
// Ejemplo de uso:
//   const { form, setField, fieldErrors, validate } = useFormFields(
//     { nombre: '', email: '' },
//     (f) => {
//       const errs = {};
//       if (!f.nombre.trim()) errs.nombre = 'Requerido.';
//       if (f.email && !f.email.includes('@')) errs.email = 'Email inválido.';
//       return Object.keys(errs).length ? errs : null;
//     }
//   );
//   ...
//   <input value={form.nombre} onChange={e => setField('nombre', e.target.value)} />
//   {fieldErrors.nombre && <div className="field-error">{fieldErrors.nombre}</div>}
//   <button onClick={() => { if (!validate()) return; submit(form); }}>Guardar</button>

import { useCallback, useState } from 'react';

export default function useFormFields(initialForm, validator) {
  const [form, setForm] = useState(initialForm);
  const [fieldErrors, setFieldErrors] = useState({});

  const setField = useCallback((key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    // Limpiar error del field al empezar a corregir. Sin esto, el error queda
    // hasta el próximo submit — el user piensa "seguí escribiendo pero sigue
    // rojo, ¿estará mal?" y se distrae del flow.
    setFieldErrors((e) => {
      if (!e[key]) return e;
      const n = { ...e };
      delete n[key];
      return n;
    });
  }, []);

  const resetErrors = useCallback(() => setFieldErrors({}), []);

  const validate = useCallback(() => {
    if (typeof validator !== 'function') return true;
    const errs = validator(form);
    if (errs && Object.keys(errs).length) {
      setFieldErrors(errs);
      return false;
    }
    setFieldErrors({});
    return true;
  }, [form, validator]);

  return {
    form,
    setForm,
    setField,
    fieldErrors,
    setFieldErrors,
    validate,
    resetErrors,
  };
}
