// Lista curada de barrios / localidades de CABA + GBA, agrupados por zona,
// para autocompletar el campo "Barrio" en Envíos. El operador puede tipear
// libre — esto solo da sugerencias. No pretende ser exhaustivo: incluye los
// barrios más usados en el día a día. Cuando aparezca uno que no está, se
// puede agregar acá o cargar a mano en el input.
//
// Estructura: array de { zona, barrios[] }. El componente BarrioCombobox
// filtra por includes() del texto tipeado y muestra los matches agrupados.
//
// 2026-06-10 — Pedido por Lucas para el modal de Nuevo envío: reemplazar el
// input libre por un combo con sugerencias por zona (Capital + Norte/Oeste/
// Sur/Este). "Zona Este" en este contexto = Gran La Plata (La Plata, Berisso,
// Ensenada y alrededores).
export const ZONAS_BARRIOS = [
  {
    zona: 'CABA',
    barrios: [
      'Agronomía', 'Almagro', 'Balvanera', 'Barracas', 'Belgrano', 'Boedo',
      'Caballito', 'Chacarita', 'Coghlan', 'Colegiales', 'Constitución',
      'Flores', 'Floresta', 'La Boca', 'La Paternal', 'Liniers', 'Mataderos',
      'Monserrat', 'Monte Castro', 'Nueva Pompeya', 'Núñez', 'Palermo',
      'Parque Avellaneda', 'Parque Chacabuco', 'Parque Chas', 'Parque Patricios',
      'Puerto Madero', 'Recoleta', 'Retiro', 'Saavedra', 'San Cristóbal',
      'San Nicolás', 'San Telmo', 'Vélez Sársfield', 'Versalles', 'Villa Crespo',
      'Villa del Parque', 'Villa Devoto', 'Villa General Mitre', 'Villa Lugano',
      'Villa Luro', 'Villa Ortúzar', 'Villa Pueyrredón', 'Villa Real',
      'Villa Riachuelo', 'Villa Santa Rita', 'Villa Soldati', 'Villa Urquiza',
    ],
  },
  {
    zona: 'Zona Norte',
    barrios: [
      // Vicente López
      'Vicente López', 'Olivos', 'Florida', 'Munro', 'La Lucila', 'Carapachay',
      'Villa Adelina', 'Villa Martelli',
      // San Isidro
      'San Isidro', 'Acassuso', 'Beccar', 'Boulogne', 'Martínez',
      // San Fernando
      'San Fernando', 'Victoria', 'Virreyes',
      // Tigre
      'Tigre', 'Don Torcuato', 'El Talar', 'General Pacheco', 'Benavídez',
      'Rincón de Milberg', 'Nordelta', 'Troncos del Talar', 'Ricardo Rojas',
      // Escobar
      'Belén de Escobar', 'Garín', 'Ingeniero Maschwitz', 'Loma Verde',
      'Maquinista Savio', 'Matheu',
      // Pilar
      'Pilar', 'Del Viso', 'Manzanares', 'Presidente Derqui', 'Villa Rosa',
      'Tortuguitas',
      // San Martín
      'San Martín', 'Villa Ballester', 'Villa Lynch', 'Villa Maipú',
      'José León Suárez', 'Loma Hermosa',
      // Tres de Febrero
      'Caseros', 'Santos Lugares', 'Sáenz Peña', 'Ciudadela', 'El Palomar',
      'Ciudad Jardín', 'Pablo Podestá',
      // Malvinas Argentinas / José C. Paz / San Miguel
      'Grand Bourg', 'Los Polvorines', 'Tierras Altas',
      'José C. Paz', 'San Miguel', 'Bella Vista', 'Muñiz',
    ],
  },
  {
    zona: 'Zona Oeste',
    barrios: [
      // Morón
      'Morón', 'Castelar', 'Haedo', 'Villa Sarmiento',
      // Hurlingham
      'Hurlingham', 'Villa Tesei', 'William Morris',
      // Ituzaingó
      'Ituzaingó', 'Villa Udaondo',
      // Merlo
      'San Antonio de Padua', 'Merlo', 'Libertad', 'Mariano Acosta', 'Pontevedra',
      // Moreno
      'Moreno', 'Cuartel V', 'Francisco Álvarez', 'La Reja', 'Paso del Rey', 'Trujui',
      // Marcos Paz / Gral. Rodríguez / Luján
      'Marcos Paz', 'General Rodríguez', 'Luján',
      // La Matanza
      'San Justo', 'Ramos Mejía', 'Lomas del Mirador', 'La Tablada', 'Tapiales',
      'Aldo Bonzi', 'Ciudad Evita', 'González Catán', 'Gregorio de Laferrere',
      'Isidro Casanova', 'Rafael Castillo', 'Villa Luzuriaga', 'Virrey del Pino',
      '20 de Junio',
    ],
  },
  {
    zona: 'Zona Sur',
    barrios: [
      // Avellaneda
      'Avellaneda', 'Sarandí', 'Wilde', 'Dock Sud', 'Villa Domínico', 'Piñeyro', 'Gerli',
      // Lanús
      'Lanús', 'Lanús Este', 'Lanús Oeste', 'Remedios de Escalada',
      'Monte Chingolo', 'Valentín Alsina',
      // Lomas de Zamora
      'Lomas de Zamora', 'Banfield', 'Temperley', 'Turdera', 'Llavallol',
      // Almirante Brown
      'Adrogué', 'Burzaco', 'Glew', 'Longchamps', 'Rafael Calzada',
      'San Francisco Solano', 'Claypole', 'Don Bosco', 'Ministro Rivadavia',
      // Quilmes
      'Bernal', 'Quilmes', 'Quilmes Oeste', 'Ezpeleta',
      // Berazategui
      'Berazategui', 'Hudson', 'Plátanos', 'Ranelagh', 'Pereyra',
      // Florencio Varela
      'Florencio Varela', 'Bosques',
      // Esteban Echeverría / Ezeiza
      'Esteban Echeverría', 'Monte Grande', 'Luis Guillón', 'El Jagüel', 'Canning',
      '9 de Abril', 'Ezeiza', 'Tristán Suárez', 'Carlos Spegazzini', 'La Unión',
      // Presidente Perón / San Vicente
      'Presidente Perón', 'Guernica', 'San Vicente', 'Alejandro Korn',
    ],
  },
  {
    zona: 'Zona Este',
    barrios: [
      // Gran La Plata
      'La Plata', 'City Bell', 'Gonnet', 'Manuel Gonnet', 'Villa Elisa',
      'Tolosa', 'Los Hornos', 'Ringuelet', 'San Carlos', 'Lisandro Olmos',
      'Olmos', 'Melchor Romero',
      // Berisso / Ensenada
      'Berisso', 'Ensenada', 'Punta Lara',
      // Magdalena / Punta Indio
      'Magdalena', 'Punta Indio', 'Verónica',
    ],
  },
];

// Mapa lookup barrio (lowercase) → zona. Permite mostrar la zona como hint
// cuando un barrio ya cargado se vuelve a editar.
export const BARRIO_TO_ZONA = (() => {
  const m = new Map();
  for (const z of ZONAS_BARRIOS) for (const b of z.barrios) m.set(b.toLowerCase(), z.zona);
  return m;
})();
