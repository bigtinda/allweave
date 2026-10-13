import { createContext, useContext } from "react";

export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}

export type ConfirmationHandler = (request: ConfirmationRequest) => Promise<boolean>;

export const ConfirmationContext = createContext<ConfirmationHandler>(async () => false);

export const useConfirmation = (): ConfirmationHandler => useContext(ConfirmationContext);
