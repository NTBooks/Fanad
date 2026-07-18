# Household memory: where's the spare key?

There's a category of information that isn't a task and isn't worth a filing system: where the spare key is, the wifi guest password, which filter the furnace takes, the name of the good plumber. You need each fact maybe twice a year, at the exact moment you can't remember it.

Fanad's Notes module is a place to throw these — and the reason it works is that you get them back **by meaning, not by exact words**.

## Turn it on, throw things in

```
you:    optin notes
you:    note the spare key is under the blue pot
fanad:  📝 Noted.
you:    n wifi guest password is sunflower42
fanad:  📝 Noted.
```

(`n` is the shortcut.) No folders, no tags. The whole discipline is: the moment you catch yourself thinking "I should remember this," say `note` and move on.

A photo with no caption lands in your notes too — snap the furnace filter label, the paint can lid, the router sticker, and it waits there for later.

## Getting things back

Months later, you don't remember what words you used. Doesn't matter — ask the question you actually have:

```
you:    r where's the spare key
fanad:  • the spare key is under the blue pot
```

`r` (or `recall`) finds notes by meaning: "where's the spare key" matches "under the blue pot" even though they share almost no words. Ask "what's the guest wifi" and the sunflower note comes back.

One promise worth knowing: recall only ever surfaces notes that actually exist. Fanad never pads an answer with something plausible-sounding — if it's not in your notes, you don't get an invented one.

## The note inbox

`notes` shows everything waiting:

```
fanad:  📝 3 waiting:
        1. the spare key is under the blue pot
        2. wifi guest password is sunflower42
        3. paint the hallway ceiling
        ("/promote 3" → task · "/forget 3" → delete)
```

That third one illustrates the other job notes do: a holding pen for maybe-tasks. "Paint the hallway ceiling" wasn't a commitment when you jotted it — but the day it becomes one, `promote 3` turns it into a real task (photo and all). And `forget 2` deletes a note you're done with.

## What tends to live here

- **Locations:** spare key, shutoff valves, the passports, the good scissors
- **Numbers and names:** wifi passwords, the plumber, paint colors by room, tire size
- **Sizes:** furnace filter, kid's current shoe size, the vacuum's bag type
- **Photos:** serial numbers, the breaker panel labels, how the shelf looked before you took it apart
- **Someday-maybes:** things you might do, not yet willing to promise

The pattern in all of it: facts with a long shelf life and no natural home. Your head was the previous storage location, and your head is a terrible filing cabinet. `note` it, forget it, `r` it back when the day comes.
