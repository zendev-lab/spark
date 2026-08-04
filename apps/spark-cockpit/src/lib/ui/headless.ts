/**
 * Cockpit's only direct Bits UI import boundary.
 *
 * Export the small primitive surface Spark currently accepts instead of
 * leaking the third-party namespaces into routes and product components.
 */
import { Command, Dialog } from "bits-ui";

export const DialogTrigger = Dialog.Trigger;
export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;
export const DialogClose = Dialog.Close;

export const CommandRoot = Command.Root;
export const CommandInput = Command.Input;
export const CommandList = Command.List;
export const CommandEmpty = Command.Empty;
export const CommandGroup = Command.Group;
export const CommandGroupHeading = Command.GroupHeading;
export const CommandGroupItems = Command.GroupItems;
export const CommandItem = Command.Item;
