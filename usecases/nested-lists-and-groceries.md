# Nested lists: groceries, packing, and everything with an inside

Not everything is a task. A grocery list isn't something you *do* — it's something you carry around and add to for a week. Same for the packing list, the gift ideas, the books people keep recommending. Fanad keeps these in Lists, a separate outliner where anything can contain anything.

## Turn it on

```
you:    optin lists
fanad:  ✓ Lists on. Make nestable lists with /lists and "/list <name>".
```

## The grocery list

Start one:

```
you:    /list Groceries
fanad:  📑 Groceries
        This list is empty. Type an item to add it, or "out" to go back. 🌱
```

While a list is open, **anything you type becomes an item**. No command per line — just rattle it off:

```
you:    milk
you:    eggs
you:    olive oil
```

This is the key thing to know about Lists: opening one is like walking into a room. Your messages land in that room until you leave (`exit`, or `out` to step up a level). If you get interrupted mid-list and need to file a real task, exit first — or just know that Fanad will tell you where you are at the top of every reply.

## Nesting: aisles inside the list

Any item can become a list of its own. Each row shows a `/sub_N` link — tap it (or type it) to descend:

```
you:    /sub_1
fanad:  📑 Groceries › Produce · 3 items
        1. apples · /sub_1
        2. bananas · /sub_2
        3. spinach · /sub_3
```

So a grocery list that organizes itself by aisle is just: top-level items named Produce, Dairy, Pantry, then descend into each and type. `/sub_2 cheddar` quick-adds a child without even going in. At the store, open Groceries and walk the aisles in order.

The same shape covers a lot of ground:

- **Trip packing** › Clothes / Toiletries / Documents / Kids
- **Home projects** › each room › what it needs
- **Gift ideas** › each person › things they've mentioned all year

## Moving around

Everything you need while inside a list fits in a few words:

| Say | What happens |
|---|---|
| *(any text)* | adds an item right here |
| `/sub_N` | open item N as its own list |
| `out` | up one level |
| `top` | jump to all your lists |
| `next` / `prev` | page through a long list |
| `del 2` | delete item 2 |
| `rename 1 cheddar` | rename item 1 |
| `exit` | leave lists entirely |

Numbers always mean the rows you're currently looking at, renumbered 1..N — never some hidden id.

`/lists` shows all your top-level lists whenever you want back in, and the web app has a Lists view for when a keyboard and a big screen beat thumb-typing.

## Lists vs. tasks vs. notes

A quick rule of thumb, since Fanad has three places things can live:

- **Task** — you'll do it, and want it off your mind: *"fix the fence gate."*
- **Note** — you'll want to recall it later: *"the spare key is under the blue pot."*
- **List** — it has structure and you'll keep coming back: groceries, packing, the wish list.

If you're unsure, just say the thing as a statement and let it be a task — you can always `drop` it. But the moment you notice yourself filing tasks like "buy milk, buy eggs, buy bread," that's a grocery list wanting to exist.
