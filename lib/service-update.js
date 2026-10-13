'use strict';

// Ersetzt die bearbeitbaren Felder eines Dienstes (Name, URL, Icon, Farbe, Gruppe);
// ID und alle übrigen Felder bleiben erhalten. Wirft bei unbekannter ID.
function updateServiceInList(services, id, validated) {
  const idx = services.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Dienst nicht gefunden');
  const merged = { ...services[idx], name: validated.name, url: validated.url, icon: validated.icon };
  if (validated.color !== undefined) merged.color = validated.color;
  if (validated.group !== undefined) merged.group = validated.group;
  const next = services.slice();
  next[idx] = merged;
  return { services: next, service: merged };
}

module.exports = { updateServiceInList };
