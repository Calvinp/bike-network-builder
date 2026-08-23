# How to use the Bike Network Builder

This is a tool that allows you to create your own bike network map. 
You can be as ambitious or constrained as you would like. 
You can choose which type of bike path each new node is (concrete separated, quick build, shared use, neighborway) and if they're one way or not.
You can select which paths are built and funded by the city vs the state, and you can see the estimated cost to each for the whole network. 
*Costs are very much a guess with extremely wide error bars.*
You can create an implementation plan with phases.
You can export your network in several ways - as a .png image file for sharing on social media, .html interactive web page, .geojson map file, or .yaml file for future import by yourself or others.

**Your work is not saved until you export either a .zip or a .yaml file!** (See Import & export below)

## Drawing paths

- **Add path**: Create a new proposed path. Click the starting location and click the path you want it to follow, then click the final node a second time to end the path.
  - If the **snap to roads** box is checked, then when you finish the path it will automatically snap to the road network (or the city borders) as well as it can. This allows you to create long paths with very few clicks. 
  - If you want your path not to follow the road network, uncheck this.
  - If you want your path to partially follow the road network, and this is snapping to roads in spots where you don't want it to, you can create multiple paths and combine them later.
- **Add existing path**: Works the same way as add path, but marks the path as already being in existence or funded.
  - This path will not add to the cost estimate.
  - This path will appear as dashed lines on the map and in exports.
- **Add spot**: Create new proposed spot infrastructure. Click where you want the infrastructure to be built.
- **Edit shapes**: Edits the route of a path that is alrerady on the map.

## Path properties

Properties of a path can be modified by clicking the path. These will show up visually in the exported map.
- **Name**: The name of the path. This will show up on the exported map if possible.
- **Status**: Proposed (your idea), funded (approved but not built), or
  existing (already on the ground).
- **Type**: The kind of path you'd like to build. See infrastructure types below.
- **Phase**: If you want to make an implementation plan, this represents the phase this path gets built in (see Phases & Dates below to edit the options here).
- **Directions**: Choose whether this is a one way or two way path.
- **Jurisdiction**: Choose whether the city or the state is expected to build this path. The cost estimate for this path will be added to the selected entity.
- **Length**: A calculated value that shows the length of the path. For two-way paths, this is not doubled. This is not modifyable directly.
- **Notes**: Any notes about the path you would like to write. Write as much or as little detail as you would like.
- **Plan an upgrade**: Click this to stage upgrades to a path across phases, or upgrade an already-existing path. 
- **Reverse direction**: Only appears for one way paths, and reverses the direction of travel for the path.
- **Combine...**: Click this then click another path to merge them. This can't be undone, so be careful with this.
- **Delete path**: Deletes the path. This can't be undone, so be careful with this.

You can also add details such as the street the path is on and the from and to intersection in More details, but these are just for your notes and do not affect the visuals.

## Spot infrastructure properties

Properties of a piece of spot infrastructure can be modified by clicking it. These will show up visually as an icon in the exported map.
- **Type**: The kind of infrastructure proposed. See infrastructure types below.
- **Name**: The name of this piece of infrastructure. Unlike for paths, naming spot infrastructure is optional.
- **Status**: Proposed (your idea) or existing (already on the ground).
- **Phase**: If you want to make an implementation plan, this represents the phase this path gets built in (see Phases & Dates below to edit the options here).
- **Jurisdiction**: Choose whether the city or the state is expected to build this infrastructure. The cost estimate for this infrastructure will be added to the selected entity.
- **Notes**: Any notes about the path you would like to write. Write as much or as little detail as you would like.

## Color modes

Change **Color by** to change how the network is colored. This will affect both your display and all exported maps. There are three choices:
- **Path type**: Different colors depending on the *type* of path. Neighborway vs concrete protected vs quick build etc. This is the default and is probably what you want.
- **Phase**: Colors by implementation phase. This is for nerdy planners.
- **One color**: Colors the entire network the same color. Not normally recommended.

All colors are color blind friendly.

## Map Layers

You can select additional layers to display on the map to help you design your bike network. These are for reference only and may be out of date if their data sources are out of date.
- **Bike Parking (existing)**: Bike parking that already exists. Imported from OSM.
- **Street trees**: Existing trees in the street. Imported from OSM.
- **Bike & pedestrian crashes**: Locations of crashes involving a bicycle or pedestrian. Imported from MassDOT.
- **Fatal & serious-injury crashes**: Locations of crashes that caused a fatality or a serious injury. Imported from MassDOT.

## Import & export

**Your work is not saved until you export either a .zip or a .yaml file!**

Exporting allows you to share your work with others. Import allows you to load your previously exported work or build on someone else's work.

- **Export**: Exports the network for sharing. There are five ways you can export:
  - **Everything (.zip)**: Exports a .zip file containing the other four files together. Also includes extra .png files of each phase, and an animated gif of the phases.
  - **Network file (.yaml)**: Exports the network as a file importable by this map or other tools. Use this to save your work for later modification, or to share your work so that others can build on it.
  - **Map image (.png)**: Exports the network as an image file. Use this to save your work for sharing on social media or in presentations. This cannot be imported later, so it does not save your work.
  - **Interactive map (.html)**: Exports the network as a webpage that can be interacted with, including with a slider showing each phase.
  - **GeoJSON (.geojson)**: Exports the network as a .geojson file that other tools can import.
- **Import**: Import a previously generated map to build on it. **Importing deletes all existing work**, so make sure you export your work if you have any. You can import either a .yaml file or a .zip file that contains the .yaml file.

## Infrastructure types

### Path infrastructure

This is infrastructure that people travel on directly.
- **Quick-build separated lane**: A lane that doesn't require construction to build. Usually separated from traffic by repainting the street to move parking between car traffic and the bike lane, and/or by using flex posts.
- **Concrete-protected lane**: A lane that is separated from traffic by physical infrastructure. This can be a concrete divider or a sidewalk level bike lane.
- **Shared-use path**: A path that is shared between pedestrians and bikes. Rail trails are usually built this way, but they can be on street and separated by flex posts or concrete too. 
- **Buffered painted lane (interim)**: A bike lane that is only separated from traffic with paint. Advocates often consider these to be low quality. They're used because they're cheap and can still help where other higher quality infrastructure is nearby. Useful as a temporary measure.
- **Neighborway (calm shared street)**: A street that is shared between bikes and cars, but measures are taken to make it more comfortable for bikes. Often these are used on narrow neighborhood streets that were already designed for low car speeds. These measures can include (but are not limited to): making it one way for cars but two ways for bikes; making small intersections into tiny roundabouts; modal filters; curb extensions; navigational signage; bright paint; street trees.
- **Pedestrianized street**: A city street that cars are entirely or almost entirely banned from using. This differs from a shared-use path because the entire street is pedestrian/bike only, and usually there are buildings facing the street. Generally provisions (such as retractable bollards) are made to allow emergency vehicles to still access the street. Sometimes the same provisions allow vehicles such as delivery trucks and personal vehicles of people who require handicap access to also use the street. Even in the cases where limited vehicle access is required, the design of the street keeps vehicle speeds low. An exception is that a street can count as pedestrianized and still have active streetcar tracks.

### Point infrastructure

This is infrastructure that exists in one specific place or at one intersection. These are improvements that enhance the experience of using nearby paths.
- **Speed hump**: A small raised section of the street. This forces cars to slow down.
- **Raised crosswalk**: A crosswalk that is raised to sidewalk level. This feels like a speed bump to occupants of cars, so it forces them to slow down, but it simultaneously provides an inviting and accessible place for pedestrians to cross the street.
- **Raised intersection**: Similar to a raised crosswalk, but this time the entire intersection is raised rather than just the crosswalks. This forces cars to take the whole intersection slowly, massively improving safety.
- **Crub extension**: A place where the curb extends into the street. This is used to force cars to slow down, improving safety.
- **Bike parking**: A secure place to park bicycles. There are many types of bike parking. If you would like to specify which type or how much, use the notes field.
- **Street trees**: A tree planted in the street to provide shade.
- **Modal filter**: A treatment, often (but not always) applied at intersections, that prevents certain types of traffic from going through while allowing others. Generally this is used to allow pedestrians, bikes, and sometimes streetcars to go through while blocking personal vehicles. This massively reduces vehicle traffic on the street while preserving access for vehicles whose destination is nearby. It is therefore popular in places where a street that is meant to be quiet is being used as a cut-through. Depending on implementation, emergency vehicles may or may not be able to drive over the modal filter if needed.
- **Bollard**: A pole that is securely fixed to the ground (often via concrete). This is often used to protect sidewalks around high speed traffic. A well implemented bollard can block even a fully loaded speeding semitruck. Note that poorly implemented bollards are fairly common. Those offer the illusion of protection while folding to the slightest crash. Care needs to be taken to ensure that it is implemented well.
- **Retractable bollard**: A bollard that can automatically retract when needed. This is a subclass of modal filter that can let some personal vehicles through but not others. This is often used to block through traffic from using a neighborhood street as a cut-throguh, while still allowing residents, deliveries, and emergency vehicles through. Often permited vehicles are issued a transponder that causes the bollard to retract for easy entry.
- **Pedestrian island**: A place in the middle of a roadway (usually between directions of traffic) where pedestrians can safely wait.
- **HAWK signal**: A special kind of traffic light that is generally off until a pedestrian presses a button to turn it on. These are used at crossing points that aren't at intersections.
- **Spot improvement**: A custom spot improvement. Use the Notes field to describe what the improvement is.

## Phases & Dates
This is for the nerdy planners out there. You can add as many phases as you would like if you intend for a phased implementation.
You can name the phases and choose the deadline for completion of the phase.

## How the cost estimate works

The cost estimates are there to give you a hint of the feasibility of your plan. They should not be taken literally. They have extremely wide error bars to show that they should not be taken literally. The engineering department would need to determine the true final cost of each path.

Each path type (quick build, neighborway, etc) has a lower and upper bound cost estimate per mile. 
The lower and upper bound cost estimate for any given path is the length of the path multiplied by the lower and upper bound for the path type. 
The total cost estimate is simply the sum of the cost estimates of each path.

The city/state split occurs because some roads are state owned. Building a path on a state owned road means the state will cover the cost of the path, but it also means the state will need to consent to building the path. Municipal level advocacy will not be sufficient to get that path built.
