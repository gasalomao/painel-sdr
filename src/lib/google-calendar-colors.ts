/**
 * Paleta OFICIAL de cores de evento do Google Calendar (colorId 1–11).
 * Fonte única usada tanto no seletor do dialog quanto na grade do /calendario,
 * pra que a cor escolhida bata exatamente com a que aparece no Google.
 *
 * Hex conferidos com a API Colors do Google (colors.get / event palette).
 */

export type GoogleColor = { id: string; name: string; hex: string };

export const GOOGLE_EVENT_COLORS: GoogleColor[] = [
  { id: "",   name: "Padrão",     hex: "#039be5" }, // sem colorId → cor padrão do calendário (Peacock)
  { id: "1",  name: "Lavanda",    hex: "#7986cb" },
  { id: "2",  name: "Sálvia",     hex: "#33b679" },
  { id: "3",  name: "Uva",        hex: "#8e24aa" },
  { id: "4",  name: "Flamingo",   hex: "#e67c73" },
  { id: "5",  name: "Banana",     hex: "#f6bf26" },
  { id: "6",  name: "Tangerina",  hex: "#f4511e" },
  { id: "7",  name: "Pavão",      hex: "#039be5" },
  { id: "8",  name: "Grafite",    hex: "#616161" },
  { id: "9",  name: "Mirtilo",    hex: "#3f51b5" },
  { id: "10", name: "Manjericão", hex: "#0b8043" },
  { id: "11", name: "Tomate",     hex: "#d50000" },
];

const COLOR_BY_ID = new Map(GOOGLE_EVENT_COLORS.map((c) => [c.id, c.hex]));

/** Hex de um colorId do Google (cai no padrão se vazio/desconhecido). */
export function hexForColorId(colorId?: string | null): string {
  return COLOR_BY_ID.get(colorId || "") || COLOR_BY_ID.get("") || "#039be5";
}

/** Cor por status quando o evento NÃO tem colorId explícito. */
const STATUS_HEX: Record<string, string> = {
  confirmed: "#039be5", // azul (padrão)
  tentative: "#f6bf26", // amarelo
  completed: "#0b8043", // verde
  no_show:   "#f4511e", // laranja
  cancelled: "#616161", // cinza
};

/**
 * Cor final do evento na grade: prioriza o colorId escolhido (sincronizado com
 * o Google); sem ele, usa a cor por status.
 */
export function colorForAppointment(appt: { color_id?: string | null; status?: string }): string {
  if (appt.color_id) return hexForColorId(appt.color_id);
  return STATUS_HEX[appt.status || "confirmed"] || "#039be5";
}
