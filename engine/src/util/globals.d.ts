// Есть и в браузере, и в Node ≥17; объявляем, чтобы движок не зависел от lib.dom и @types/node.
declare function structuredClone<T>(value: T): T;
