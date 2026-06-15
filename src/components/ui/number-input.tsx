"use client";

import * as React from "react";
import { Input } from "./input";

/**
 * Input numérico controlado que NÃO trava o usuário em "1" quando ele tenta
 * apagar pra digitar outro número.
 *
 * O bug do `<Input type="number" value={x || 1} onChange={e => set(Number(e.target.value) || 1)}/>`
 * é que `Number("")` é 0, `0 || 1` é 1, então apagar tudo restaura 1
 * imediatamente — impossível digitar "300", "30", etc.
 *
 * Aqui mantemos um estado-string interno: o usuário pode apagar pra vazio
 * livremente, e só no blur (ou ao perder o foco) caímos pro `fallback`
 * (ou min) se ficou vazio. Enquanto digita, propagamos o número assim
 * que ele forma um número válido.
 */
type Props = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> & {
  value: number | null | undefined;
  onChange: (n: number) => void;
  /** Valor usado quando o campo é deixado em branco no blur. Default: min ?? 0. */
  fallback?: number;
  min?: number;
  max?: number;
};

export function NumberInput({
  value,
  onChange,
  fallback,
  min,
  max,
  ...rest
}: Props) {
  const [text, setText] = React.useState<string>(value == null ? "" : String(value));

  // Sincroniza com mudanças externas (ex: reset do form). Compara o número
  // parseado pra não interromper a digitação intermediária ("3" enquanto vai
  // digitar "300").
  React.useEffect(() => {
    const parsed = text === "" ? NaN : Number(text);
    if (value != null && parsed !== value) {
      setText(String(value));
    } else if (value == null && text !== "") {
      setText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <Input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (v === "") return; // ainda não propaga — espera o usuário terminar
        const n = Number(v);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onBlur={(e) => {
        if (text === "" || Number.isNaN(Number(text))) {
          const fb = fallback ?? min ?? 0;
          setText(String(fb));
          onChange(fb);
        } else {
          let n = Number(text);
          if (typeof min === "number" && n < min) n = min;
          if (typeof max === "number" && n > max) n = max;
          if (n !== Number(text)) setText(String(n));
          onChange(n);
        }
        rest.onBlur?.(e);
      }}
    />
  );
}
