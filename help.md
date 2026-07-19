# How to use the Bike Network Builder

This is a tool that allows you to create your own bike network map. 
You can be as ambitious or constrained as you would like. 
You can choose which type of bike path each new node is (concrete separated, quick build, shared use, neighborway) and if they're one way or not.
You can select which paths are built and funded by the city vs the state, and you can see the estimated cost to each for the whole network. 
*Costs are very much a guess with extremely wide error bars.*
You can create an implementation plan with phases.
You can export your network in several ways - as a .png image file for sharing on social media, .html interactive web page, .geojson map file, or .yaml file for future import by yourself or others.

**Your work is not saved until you export either a .zip or a .yaml file!**

## Drawing paths

- **Add path**: Create a new proposed path. Click the starting location and click the path you want it to follow, then click the final node a second time to end the path.
  - If the **snap to roads** box is checked, then when you finish the path it will automatically snap to the road network (or the city borders) as well as it can. This allows you to create long paths with very few clicks. 
  - If you want your path not to follow the road network, uncheck this.
  - If you want your path to partially follow the road network, and this is snapping to roads in spots where you don't want it to, you can create multiple paths and combine them later.
- **Add existing path**: Works the same way as add path, but marks the path as already being in existence or funded.
  - This path will not add to the cost estimate.
  - This path will appear as dashed lines on the map and in exports.
- **Edit shapes**: Edits the route of a path that is alrerady on the map.

## Path properties

Properties of a path can be modified by clicking the path. These will show up visually in the exported map.
- **Name**: The name of the path. This will show up on the exported map if possible.
- **Status**: Proposed (your idea), funded (approved but not built), or
  existing (already on the ground).
- **Type**: Quick-build separated lane, concrete-protected lane, shared-use
  path, buffered painted lane, or neighborway (a traffic-calmed shared
  street).
- **Phase**: If you want to make an implementation plan, this represents the phase this path gets built in (see Phases & Dates below to edit the options here).
- **Directions**: Choose whether this is a one way or two way path.
- **Jurisdiction**: Choose whether the city or the state is expected to build this path. The cost estimate for this path will be added to the selected entity.
- **Length**: A calculated value that shows the length of the path. For two-way paths, this is not doubled. This is not modifyable directly.
- **Notes**: Any notes about the path you would like to write. Write as much or as little detail as you would like.
- **Reverse direction**: Only appears for one way paths, and reverses the direction of travel for the path.
- **Combine...**: Click this then click another path to merge them. This currently can't be undone directly, so be careful with this.
- **Delete path**: Deletes the path. This can't be undone, so be careful with this.

You can also add details such as the street the path is on and the from and to intersection in More details, but these are just for your notes and do not affect the visuals.

## Color modes

Change **Color by** to change how the network is colored. This will affect both your display and all exported maps. There are three choices:
- **Path type**: Different colors depending on the *type* of path. Neighborway vs concrete protected vs quick build etc. This is the default and is probably what you want.
- **Phase**: Colors by implementation phase. This is for nerdy planners.
- **One color**: Colors the entire network the same color. Not normally recommended.

All colors are color blind friendly.

## Import & export

**Your work is not saved until you export either a .zip or a .yaml file!**

Exporting allows you to share your work with others. Import allows you to load your previously exported work or build on someone else's work.

- **Export**: Exports the network for sharing. There are five ways you can export:
  - **Everything (.zip)**: Exports a .zip file containing the other four files together.
  - **Network file (.yaml)**: Exports the network as a file importable by this map or other tools. Use this to save your work for later modification, or to share your work so that others can build on it.
  - **Map image (.png)**: Exports the network as an image file. Use this to save your work for sharing on social media or in presentations. This cannot be imported later, so it does not save your work.
  - **Interactive map (.html)**: Exports the network as a webpage that can be interacted with.
  - **GeoJSON (.geojson)**: Exports the network as a .geojson file that other tools can import.
- **Import**: Import a previously generated map to build on it. **Importing deletes all existing work**, so make sure you export your work if you have any. You can import either a .yaml file or a .zip file that contains the .yaml file.

## Phases & Dates
This is for the nerdy planners out there. You can add as many phases as you would like if you intend for a phased implementation.
You can name the phases and choose the deadline for completion of the phase.

## How the cost estimate works

The cost estimates are there to give you a hint of the feasibility of your plan. They should not be taken literally. They have extremely wide error bars to show that they should not be taken literally. The engineering department would need to determine the true final cost of each path.

Each path type (quick build, neighborway, etc) has a lower and upper bound cost estimate per mile. 
The lower and upper bound cost estimate for any given path is the length of the path multiplied by the lower and upper bound for the path type. 
The total cost estimate is simply the sum of the cost estimates of each path.

The city/state split occurs because some roads are state owned. Building a path on a state owned road means the state will cover the cost of the path, but it also means the state will need to consent to building the path. Municipal level advocacy will not be sufficient to get that path built.
