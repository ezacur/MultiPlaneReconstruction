# MPR Viewer: notas de diseno

Este documento explica como esta construido el visor y por que: la geometria del
plano, el manipulador, la barra de grises y las decisiones de implementacion.
Para instalarlo y usarlo, ver el [README](../README.md).

## El plano

El estado geometrico son tres cosas:

- una terna ortonormal `(u, v, n)` de direcciones de mundo, donde `u` es la
  derecha y `v` el arriba de la imagen que se pinta sobre el plano, y `n = u x v` es la normal;
- un **pivote**, el punto sobre el que giran los arrastres. Esta fijo en el
  centro del volumen, como el `Center` de `draggablePlaneWidget.m`;
- una **distancia**, el desplazamiento del plano respecto del pivote a lo largo
  de la normal.

El plano vive en `pivote + n * distancia`. Un plano oblicuo no es un caso
especial: es simplemente una terna que no esta alineada con la rejilla de
voxeles ni con los ejes del paciente.

Si el array es de I x J x K, el plano de adquisicion es `I-J`: el que recorre el
indice K. Es el que sale por defecto.

Hay dos formas directas de llevar el plano a una cartesiana de la rejilla:

- las teclas **I**, **J** y **K**, que lo llevan al plano de normal I, J o K
  pasando por el centro del volumen;
- un **doble clic sobre una marca de color del anillo**: la roja lleva al plano
  de normal I, la verde al de J y la azul al de K. Es un atajo del giro que la
  marca ofrece: el plano gira, animado, alrededor del eje que tendria un
  arrastre empezado en esa marca, y se detiene en la parada que muestra la
  esfera hueca. Como un arrastre, conserva el desplazamiento del plano, con el
  mismo recorte contra el volumen, en vez de devolverlo al centro. Al pasar el raton por encima
  de una marca, esta se resalta mostrando su borde, y la pista de la vista dice
  a que plano lleva. La zona que responde ocupa todo el ancho del anillo, no solo
  la franja fina de color, para que sea facil acertar.

Un doble clic en el vacio, fuera del plano, reencuadra la camara.

Cambiar de plano no salta: la orientacion se interpola como un slerp de
cuaterniones, asi que el plano gira visiblemente hasta su destino en unos 420
ms, y el offset se acompasa a la vez. Cualquier gesto manual, ya sea el
manipulador 3D o la rueda, cancela la transicion en curso.

El destino no es una terna concreta sino toda una familia. Lo que se ve es el
corte, y el corte solo depende del plano: ni el sentido de la normal ni el giro
de los ejes dentro del plano cambian un solo pixel. Asi que la transicion apunta
al miembro mas cercano de esa familia, es decir al giro minimo que lleva la
normal actual sobre el eje destino, tomando de sus dos sentidos el mas proximo.
Ese giro nunca pasa de 90 grados:

| Estado de partida | Giro que hace | Minimo posible |
| --- | --- | --- |
| Girado 70 grados dentro del plano | 0 | 0 |
| Normal invertida | 0 | 0 |
| Inclinado 100 grados | 80 | 80 |
| Inclinado 40 grados | 40 | 40 |

Interpolar hacia una terna fija habria dado 70, 180 y 100 grados en los tres
primeros casos, girando de mas sin cambiar nada de lo que se ve.

## Snap a la cartesiana

A menos de un par de grados de uno de los ejes de la rejilla, la normal cae
exactamente sobre el. Sin esto, un arrastre que simplemente pase cerca de uno
deja el plano una fraccion de grado oblicuo y la imagen no termina de asentarse.
El margen es de 2.5 grados (`cartesianSnapDeg` en `src/scene.ts`). Fuera de ese
margen la normal es continua.

Como el signo de la normal no cambia el corte, la comparacion va sobre el valor
absoluto del producto escalar y al ganador se le da el signo de la direccion
pedida. El snap se aplica despues de cada giro manual, nunca durante una
transicion animada: ahi el movimiento debe leerse continuo y el destino ya es
exacto. Tras mover la normal, los ejes del plano se reconstruyen alrededor de
ella conservando la orientacion todo lo que se puede.

Se probo ademas restringir la normal a una nube discreta de direcciones mas alla
del snap, y se descarto: hacia que girar el plano se sintiera a trompicones. El
banco que lo midio es `tools/quantise-lab.html`, autonomo y sin build, que se
mantiene porque tambien es la forma mas comoda de elegir el angulo de snap.
Muestra la nube sobre una esfera girable, los casquetes de enganche a I, J y K,
y un barrido con dos graficas: cuanto se aparta la normal cuantizada de la
pedida, y el salto que pega el plano en cada cambio de direccion.

## El manipulador

Portado de `draggablePlaneWidget.m` del repositorio `volumetric-visualization`.
El plano lleva un **anillo** concentrico, una banda traslucida sin bordes que va
de 0.85 a 1.0 del radio del manipulador. La zona de agarre coincide exactamente
con lo que se ve. Hay dos gestos:

- **inclinar**: arrastrar el anillo con el boton izquierdo. Gira el plano sobre
  un eje contenido en el, que pasa por el pivote y es perpendicular al radio
  agarrado. El punto agarrado recorre un arco visible, de -100 a +100 grados, y el
  rayo del puntero se proyecta sobre ese arco para obtener el angulo;
- **deslizar**: arrastrar desde la imagen, o el anillo con cualquier otro boton.
  El hueco entre la imagen y el anillo no lleva imagen, asi que un arrastre ahi
  pertenece a la camara y no al plano. Mueve el plano por su propia normal. El rayo del puntero
  se proyecta sobre la recta normal que pasa por el punto agarrado, asi que el
  plano sigue al raton exactamente en vez de acumular incrementos. Esa recta se
  dibuja a trazos durante el arrastre, y queda fija en el espacio: esta anclada
  al desplazamiento con el que empezo el gesto, no al que el plano tenga en cada
  instante.

El reparto es: el anillo inclina, la imagen desliza, y el vacio orbita la
camara, tanto el de alrededor como el hueco entre la imagen y el anillo.

El anillo no esta siempre a la vista. Aparece en medio segundo cuando el raton
pasa por la imagen o por el propio anillo, se queda mientras dura un arrastre,
y se desvanece en dos segundos cuando el raton se va, de modo que en reposo el
corte se ve limpio. La caja del volumen tiene su propia regla: se enciende
solo mientras el raton esta sobre la imagen, y empieza a apagarse en cuanto sale
de ella, tambien si pasa al anillo. Aparece en el mismo medio segundo, pero se
apaga en diez, mucho mas despacio que los dos segundos del anillo. Al cargar un volumen
se muestran y se desvanecen, para que se vea que estan.

Las dos guias del arrastre, el arco de giro y el rail de desplazamiento, son
discontinuas y con trazos de la misma longitud en el espacio: la del rail, que
divide su recorrido en 48 tramos. Las dos quedan fijas en el espacio desde el
principio del gesto, trazos incluidos, asi que no se mueven mientras el plano
gira o se desliza. Se dibujan con profundidad real: la imagen y el propio anillo las tapan por detras.
Ademas son cintas en espacio de pantalla **sombreadas como cilindros**. El
fragment shader reconstruye la normal de un tubo visto de lado a partir de la
posicion transversal del pixel, lo ilumina con una luz fija ligeramente por
encima del observador y suaviza la silueta, asi que la curva se ve redonda y no
como una banda plana. Encima, el grosor, la opacidad y la niebla van por vertice
y siguen la distancia a la camara de forma continua: del extremo cercano al
lejano pasan de 5.4 a 1.1 pixeles de grosor, de opaco a 12 por ciento de
opacidad, y se funden hasta un 75 por ciento hacia el color del fondo. Todo eso,
con la oclusion, es lo que permite leer como 3D una curva que pasa por delante y
por detras del plano.

Al empezar cualquiera de los dos arrastres aparece una bolita blanca sobre el
anillo, en el punto desde el que se esta tirando. Se guarda en coordenadas del
propio plano, asi que es un punto material del anillo: viaja con el al inclinar
y se desliza con el al desplazar. Es un disco encarado a la camara, que sin
iluminacion en la escena se lee igual que una esfera.

Los dos gestos son absolutos: el angulo y el desplazamiento se recalculan desde
la terna capturada al empezar el arrastre, por lo que no derivan. `Esc`
restaura ese estado.

El pivote esta fijo en el centro del volumen, asi que un desplazamiento que
cabia a lo largo de la normal de partida puede quedar fuera del volumen a lo
largo de la nueva. En un volumen muy largo en K, un plano axial cerca de la tapa
inclinado 90 grados acabaria fuera de la caja y se perderia. Para evitarlo,
durante el giro el desplazamiento se recorta contra el volumen tal como mira el
plano en cada momento, dejando un margen del 5 por ciento del rango, y nunca
menos de un voxel, para que siempre corte una imagen y no solo roce una arista.
El recorte se hace siempre desde el desplazamiento con el que empezo el gesto,
asi que al deshacer el giro el plano recupera su sitio. Medido en un volumen de
100 x 100 x 400 con el plano a 180 mm del centro: inclinado 90 grados queda a
45 mm, junto a la cara lateral, y al volver a 0 grados vuelve a 180. Las
transiciones animadas a una cartesiana se recortan igual en cada frame.

### El eje del giro y el rayo al puntero

Al pasar el raton por el anillo, y durante todo el giro, se dibuja el **eje**
sobre el que gira el plano: un cilindro corto (el 37.5 por ciento del radio a
cada lado del pivote) de 8 pixeles de grosor constante, cuya opacidad baja con
la profundidad. Antes de arrastrar muestra el eje que tendria un arrastre
empezado en ese punto del anillo, y se actualiza al moverse por el.

Junto a el va un **rayo** fino del eje al puntero, que es el radio agarrado:
sale del pivote, el punto del eje mas cercano al puntero, y acaba en el punto
del anillo bajo el raton, o durante el giro en el punto agarrado mientras
recorre el arco. Es el mismo tubo del arco, adelgazado y con niebla.

La imagen y el anillo tapan los dos donde pasan por detras. El eje es paralelo
al plano y pasa por el pivote, asi que con el plano en el centro queda dentro
del propio corte; un paso de profundidad hacia la camara resuelve ese empate
sin sacarlo por delante de la imagen cuando de verdad esta detras.

El anillo y la imagen estan en el mismo plano y se solapan, asi que quien
queda delante se decide a proposito, con un desplazamiento de profundidad: en
reposo gana la imagen, y en cuanto el anillo se resalta bajo el raton o se
esta arrastrando, pasa por delante. Sin eso los dos empatan en profundidad y la
interseccion parpadea al girar.

### Donde coger el anillo para llegar a una cartesiana

Sobre el borde exterior del anillo, del radio 0.97 al 1, hay unos tramos
tenues del color del plano al que llevan (rojo I, verde J, azul K): agarrandolo
dentro de uno, el giro puede caer en ese
plano de la rejilla. Cada eje sale dos veces, en lados opuestos, porque cada
lado inclina hacia el mismo plano en un sentido distinto, y el eje sobre el que
ya esta el plano no sale. El ancho es la ventana real con el snap: agarrando el
anillo en el angulo p del plano se gira sobre el eje a(p) = sin p u - cos p v,
y un eje de la rejilla g se alcanza cuando L |sin(p - p0)| < sin(snap), con L y
p0 la longitud y el angulo de la proyeccion de g sobre el plano. Se recalculan
en cada frame, asi que siguen al giro mientras se arrastra.

Durante el giro, una **esfera hueca** sobre el arco marca cada angulo en el que
el plano cae sobre una cartesiana, en el color que tomara el borde. Esta
dimensionada para que la bolita del arrastre quepa dentro al engancharse.

## El cuerpo y su pedestal

Junto al volumen hay una superficie de cuerpo humano: Cesium Man, de las
muestras glTF de Khronos (© 2017 Cesium, CC-BY 4.0), reducido a un busto.
`tools/body-from-gltf.mjs` toma la malla en su pose de reposo, sin textura ni
esqueleto, la gira a los ejes RAS del paciente (el modelo mira hacia +X con Z
arriba: +X pasa a anterior, +Z a superior, +Y a izquierda, un giro y no un
espejo), la escala a 1700 mm de estatura y la corta a media altura. Los
triangulos que cruzan el corte se recortan con vertices nuevos sobre el, para
que la base sea un borde limpio, y el corte queda en S = 0. El resultado,
`public/models/body.json`, son unos 2700 vertices y 3600 triangulos.

El cuerpo se dibuja solo por su silueta: la linea donde la superficie pasa de
mirar al ojo a darle la espalda, calculada en cada frame para la vista de ese
momento (`src/silhouette.ts`). Tomada arista a arista entre triangulos
delanteros y traseros, en una malla tan gruesa como esta saldria en zigzag por
los triangulos. Se toma en cambio donde la superficie suave que describen las
normales de los vertices queda de canto: en cada triangulo, la recta donde la
normal interpolada es perpendicular a la vista, entre los dos puntos de sus
aristas donde eso cruza cero, igual que se calcula el contorno del corte. Asi
salen curvas suaves y unidas. Se descartan los triangulos que miran claramente
al ojo o en sentido contrario (coseno mayor de 0.5), donde un cruce solo puede
venir de normales que no encajan con la forma, y se anade el borde abierto del
corte de la cadera. Para hallar ese borde, y las aristas de las sombras, los
vertices en el mismo sitio cuentan como uno: el modelo los duplica en las
costuras de la textura, y sin soldarlos las costuras de la cabeza se leian
como bordes.

La silueta se dibuja al final, en tres pasadas: toda ella tenue, sin prueba de
profundidad, para que lo que tapan el propio cuerpo o el corte se siga viendo,
como las lineas ocultas de un plano; luego la superficie solo en profundidad,
sin color y empujada un poco hacia atras para no tapar la linea que esta sobre
ella; y la silueta otra vez, solida, donde nada la tapa. Va la ultima porque su
profundidad ocultaria lo que se dibujara despues detras de una superficie que
no se ve.

Donde el cuerpo cruza el plano de corte se dibuja una linea roja. Se calcula en
cada frame: cada triangulo del cuerpo, alli donde lo haya puesto el pedestal,
que tiene esquinas a los dos lados del plano da un segmento entre los dos
puntos donde sus aristas lo cruzan (una esquina sobre el plano cuenta como de
un lado, para no contar dos veces un cruce). Los segmentos se recortan a la
imagen, la parte del plano dentro del volumen, en el espacio de voxel, donde la
caja esta alineada con los ejes. Con la malla del busto son unos pocos miles de
triangulos y el contorno sale cerrado; como esta en el propio plano, se dibuja
encima de la imagen en vez de competir con ella en profundidad.

El volumen, el plano y su anillo estan quietos en la escena. El cuerpo vive en
su propio espacio, y una transformacion rigida, `scene.bodyModel`, lo coloca en
la escena; es lo unico que mueve el **pedestal**. Al cargar, el cuerpo se coloca
con el ombligo (el 20 por ciento de la altura del busto, unos 170 mm sobre el
corte) en el centro del volumen y mirando como el paciente.

El pedestal es un cilindro bajo el corte de la cadera: el eje va hacia arriba
del cuerpo, la tapa esta contra el corte, el radio abarca la seccion del corte
con un margen y la altura es un 39 por ciento del radio. En reposo es una forma
translucida y tenue. Cada una de sus tres partes, el borde de la tapa, su
centro y el lateral, se vuelve solida y sombreada por separado mientras el
puntero esta sobre ella o mientras un arrastre la tiene cogida; el resto sigue
tenue. Solida, escribe
profundidad para ocultar lo que tiene detras y se sombrea con una luz desde el
ojo. Cada parte muestra su guia ya al pasar por encima: el borde, el arco de la
inclinacion, de -60 a +60 grados; el centro, la linea del desplazamiento a lo
largo del eje por el punto agarrado; el lateral, el circulo alrededor del eje
que recorre el punto agarrado al girar, un poco por fuera de la superficie
para no confundirse con las estrias. Las tres se calculan en la escena, asi
que durante el gesto se quedan quietas aunque el pedestal se mueva, y se
dibujan sin prueba de profundidad: el arco pasa bajo el corte y se mete en el
pedestal, y probado contra la profundidad quedaria casi todo oculto. El lateral va estriado, 32 estrias alternas claras y oscuras, para que
el giro sobre el eje se vea; el borde de la tapa es liso. Durante el arrastre la
caja del volumen se enciende, y al soltar se desvanece con su fundido largo.
Sus gestos:

| Zona | Boton | Gesto |
| --- | --- | --- |
| Borde de la tapa (del 0.6 al 1 del radio) | izquierdo | Inclinar alrededor del centro de la tapa |
| Centro de la tapa | izquierdo o central | Desplazar a lo largo del eje |
| Borde de la tapa | central | Desplazar a lo largo del eje |
| Lateral | izquierdo | Girar sobre el eje |
| Lateral | central | Mover en el plano de la pantalla |
| Lateral | derecho | Mover en el plano perpendicular al eje |

Con la orbita, en el centro del cuerpo, el de la caja del busto, hay un gizmo
de rotacion tradicional: tres anillos de radio el 28 por ciento del del pedestal, sobre los
ejes R, A y S del cuerpo, en rojo, verde y azul, que giran el cuerpo alrededor
de ese centro. Se cogen antes que todo lo demas, el anillo y la imagen del plano
de corte incluidos, si el puntero pasa a menos del 8 por ciento de su radio de
uno de ellos: son finos y, donde se ven, se pueden coger. Se dibujan sin prueba
de profundidad, para que se vean a traves del cuerpo, y el anillo ofrecido o
cogido se dibuja mas grueso. Completan el gizmo un circulo exterior blanco, un
30 por ciento mayor y siempre de frente a la camara, que gira el cuerpo
alrededor de la linea de vision (su eje se fija al pulsar, para que el giro no
cambie de eje si la vista del cuerpo cambia), y un centro, un disco blanco con
cuatro flechas, que lo mueve en el plano de la pantalla.

El pedestal y el gizmo se desvanecen cuando no se usan. Aparecen en 0.25
segundos mientras se arrastran o el puntero esta sobre el pedestal, el gizmo o
el propio cuerpo (el rayo se prueba contra los triangulos del busto), se
mantienen 5 segundos tras el ultimo uso y se apagan en 1.5. Durante esa espera
no hace falta redibujar: la app programa un unico redibujado para cuando toca
empezar el fundido. Mientras se desvanecen ninguna parte escribe profundidad,
para no tapar nada a medio camino.

Un detalle de las cintas con profundidad (las guias y los anillos): su grosor y
su opacidad se reparten entre el punto mas cercano y el mas lejano de la curva.
En una curva sin profundidad, como el circulo blanco, que mira a la camara, esa
diferencia es solo ruido de redondeo, y repartirla daba en cada frame un grosor
y una opacidad al azar: el circulo parpadeaba. Por debajo de una centesima de
milimetro de profundidad la cinta se trata como plana.

Los giros del gizmo, del lateral y del borde de la tapa se leen por arrastre
tangencial, como en los
editores 3D: el angulo es lo que el puntero ha recorrido en pantalla a lo largo
de la imagen de la tangente del punto agarrado, dividido por su radio. Cada
pixel es siempre la misma fraccion de giro. Leer el angulo de la posicion del
puntero sobre el plano del anillo, o del punto donde corta el lateral, daba
tirones: cerca de la silueta del cilindro, o con el anillo visto inclinado o el
puntero cerca de su centro, un pixel valia muchos grados, y el cuerpo se veia
temblar al girarlo. Como la camara es ortografica, todos los rayos comparten
direccion y su origen se desplaza con el puntero, que es lo que se mide. Si la
tangente se ve casi de punta, su longitud en pantalla se toma como minimo un 30
por ciento del radio, para que el giro no se dispare.

Como los del plano, son absolutos: cada paso se calcula desde la transformacion
con que empezo el arrastre, y los rayos y la direccion de la camara se llevan al
espacio del cuerpo con ella, no con la que va cambiando. La inclinacion proyecta
el puntero sobre el arco del punto agarrado, de -60 a +60 grados, alrededor de
un eje en la tapa que pasa por su centro, perpendicular al radio agarrado; como
el centro de la tapa esta en el espacio del cuerpo, gira alrededor de donde este
la tapa en ese momento. El giro sobre el eje toma el punto donde el puntero
corta el lateral por la cara que se ve: un rayo atraviesa el cilindro dos veces,
y quedarse con el corte de detras haria girar al reves. Fuera de la silueta usa
el punto del circulo agarrado mas cercano al rayo, que enlaza sin salto con el
borde. Los desplazamientos siguen el puntero sobre el plano de la pantalla, o
sobre el plano perpendicular al eje, por el punto agarrado, y se quedan quietos
si ese plano se ve de canto.

El encuadre de la camara abarca la caja del volumen, la caja del cuerpo y el
pedestal, donde esten. Se fija al reencuadrar (al cargar, o con un doble clic
en el vacio) y no se recalcula en cada frame: si lo hiciera, la escala de la
vista seguiria al cuerpo mientras el pedestal lo mueve, y la camara se moveria
bajo el gesto. La profundidad de la camara se extiende de sobra a los
dos lados del punto de mira, para que el pedestal pueda alejar el cuerpo sin
recortarlo.

## Los manipuladores del cuerpo

El pedestal y el gizmo de anillos son dos de los nueve manipuladores del
cuerpo, el pedestal y la orbita, y el panel elige cual esta activo. Los dos
salen de la misma clase, `Pedestal`, que segun su modo solo coge y dibuja sus
propias piezas. Todos cumplen el mismo contrato (`Manipulator`, en
`src/manip/common.ts`): dicen si un rayo coge una de sus asas finas, que van
antes que el anillo y la imagen del plano; empiezan, siguen y terminan un
arrastre; deshacen el arrastre con Esc; dan su texto de ayuda y su cursor; y
devuelven su geometria, una parte en el espacio del cuerpo y otra en el de la
escena. Todos mueven el cuerpo cambiando `scene.bodyModel`, y todos sus gestos
son absolutos: cada paso se calcula desde la colocacion del principio del
arrastre. Los que trabajan en la escena componen su movimiento delante de esa
colocacion (`local * model0`); el pedestal, que trabaja en el espacio del
cuerpo, detras (`model0 * local`).

`BodyControls` (`src/manip/controls.ts`) guarda los nueve y reparte los eventos
al activo, y lleva lo que comparten:

- el **desvanecido**, el mismo de antes (0.25 s de entrada, 5 s de espera,
  1.5 s de salida), que cuenta como uso el arrastre, el puntero sobre una asa o
  sobre el cuerpo y las transiciones. La alineacion por puntos no se desvanece:
  sus puntos son el trabajo en curso;
- el **ajuste a pasos**: 15 grados en los giros y 5 mm en los desplazamientos.
  Un desplazamiento se redondea a lo largo de los ejes propios del gesto (el
  eje de la flecha, los dos del plano o los de la pantalla), y lo que tenga
  fuera de ellos se descarta. Un giro libre, como el del trackball, redondea su
  angulo y conserva su eje. La casilla del panel lo activa; Shift durante el
  arrastre lo invierte;
- las **transiciones**: el cubo y la alineacion por puntos no mueven el cuerpo
  de golpe, sino que lo llevan en 450 ms a su sitio. Se interpola el giro con
  slerp y la traslacion del centro del cuerpo, no la de su origen, para que gire
  sobre si mismo en vez de barrer un arco alrededor del corte de la cadera;
- la **prueba del rayo contra el cuerpo** (Moller-Trumbore sobre sus
  triangulos), que da el punto de la superficie para la alineacion y la
  presencia del puntero sobre el cuerpo para el desvanecido;
- el **tamano del pixel** en milimetros de escena, que el raton actualiza en
  cada evento, para que las tolerancias de las asas se midan en pixeles y no
  cambien con el zoom.

Las asas de los gizmos son las de los editores 3D, en `src/manip/handles.ts`:
una flecha mueve a lo largo de su eje (el rayo se proyecta sobre la recta por el
punto agarrado, como el desplazamiento del plano), un cuadrado mueve en el
plano de sus dos ejes, un anillo gira por arrastre tangencial alrededor de su
eje por el centro del gizmo, y el centro mueve en el plano de la pantalla. Se
cogen a menos de 8 pixeles; el asa ofrecida se aclara y engruesa, y la flecha
cogida muestra su recta discontinua. De ahi salen dos manipuladores:

- **Gizmo anclado al plano de corte.** Se coloca en el plano, donde cae en
  perpendicular el centro del cuerpo, y usa los ejes del plano: la flecha de la
  normal, en su color y hacia el lado de la camara; dos flechas blancas por u y
  v; un cuadrado en el plano; y un anillo alrededor de la normal. Cada asa
  cambia el contorno rojo de una manera clara: la normal lo hace crecer o
  menguar, las del plano lo desplazan y el anillo lo gira.
- **Flechas de traslacion.** En el centro del cuerpo, por los ejes R, A y S de
  la escena (no los del cuerpo, para que un movimiento siga las direcciones del
  volumen aunque el cuerpo este girado), con tres cuadrados entre cada dos ejes,
  cada uno en el color del eje que deja quieto, y el centro.

**Arrastre sobre el corte.** Sin asas: con el boton izquierdo, la imagen
del corte es del cuerpo y no del plano (el anillo del plano sigue siendo suyo).
Dentro del contorno rojo traslada el cuerpo por el plano; fuera, lo gira
alrededor de la normal por el centro del contorno, con el angulo del puntero
alrededor de ese centro. Para saber si un punto esta dentro no hace falta
ordenar los segmentos del contorno: basta contar cuantos cruza una semirrecta
desde el punto, y si son impares esta dentro. El centro es la media de los
puntos medios de los segmentos ponderada por su longitud. Sin contorno, toda la
imagen cuenta como dentro. Alt + rueda mueve el cuerpo por la normal un corte
por paso, el mismo paso que la rueda da al plano.

**Alineacion por puntos.** Clic en el cuerpo pone un punto, en su espacio, para
que viaje con el; clic en la imagen pone su pareja, en la escena, para que se
quede con el volumen. Con cada pareja completa el cuerpo se lleva a la
colocacion rigida que mejor las junta: con una, la traslacion que las hace
coincidir; con dos, el menor giro que alinea los segmentos y la traslacion que
junta sus puntos medios, porque dos puntos no fijan el giro alrededor de su
recta y asi se toca lo menos posible; con tres o mas, el ajuste por minimos
cuadrados de Horn, cuyo giro es el vector propio del mayor valor propio de una
matriz simetrica de 4 por 4 hecha con la covarianza cruzada de los puntos,
calculado aqui con barridos de Jacobi. El panel da la distancia media que queda
entre las parejas. Los puntos del cuerpo son discos con borde oscuro; los de la
imagen, anillos del mismo color; una linea discontinua une los de cada pareja
mientras esten separados. Cada punto se puede arrastrar (el del cuerpo por su
superficie, el de la imagen por el corte), y al soltarlo se reajusta.

**Trackball.** Una esfera del 40 por ciento de la altura del busto alrededor de
su centro. El puntero se pone sobre ella como en el trackball de Bell: sobre la
esfera cerca del centro y sobre una hoja hiperbolica mas alla, para que el giro
siga suave al cruzar el borde. El giro es el que lleva el punto de la pulsacion
al punto actual. El borde, a 9 pixeles, gira alrededor de la linea de vision
con el angulo del puntero alrededor del centro. Tres circulos maximos sobre los
ejes del cuerpo giran con el y dejan ver el rodar.

**Cubo de orientacion.** Un cubo flotando sobre la cabeza, en el espacio del
cuerpo, con las caras R, L, A, P, S e I: las positivas en los colores de los
ejes y las negativas en un tono mas oscuro, con la letra trazada con lineas. Se
dibujan solo las caras que miran a la camara; al ser convexo, nunca se tapan
entre si y no hace falta ordenarlas. Un clic en una cara lleva el cuerpo al
giro que pone esa cara de frente a la camara y su letra derecha: el giro que
lleva la terna de la cara (derecha, arriba, normal) a la de la pantalla. Un
clic derecho la pone de frente al plano de corte, por el lado de la camara, con
el arriba de la pantalla tumbado en el plano. Arrastrar gira el cuerpo: lo que
recorre el puntero en horizontal gira alrededor del arriba de la pantalla, y en
vertical alrededor de su derecha, un cuarto de vuelta por cada ancho del cubo.
Una pulsacion que se mueve menos de 4 pixeles es un clic.

**Sombras en las paredes.** Las paredes son las caras del fondo de una sala con
los ejes de la rejilla del volumen, que abarca el volumen y la caja del cuerpo
alli donde este, con un 6 por ciento de margen: con un estudio pequeno y un
busto grande, las paredes del volumen se quedarian cortas para sus sombras.
Para cada eje se elige la cara que se aleja de la camara, y durante un arrastre
la pared cogida se queda quieta. La sombra es la proyeccion perpendicular a la
pared: el relleno, los triangulos del cuerpo vueltos hacia la pared, que entre
todos cubren la silueta mas o menos una vez; y el contorno, las aristas entre un
triangulo vuelto hacia la pared y otro que no, mas el borde abierto del corte
de la cadera. La adyacencia de aristas y las normales se calculan una vez por
malla. Una sombra se coge donde se ve, no a traves de la imagen del corte, que
tapa las paredes de detras. Arrastrarla mueve el cuerpo en el plano de su
pared, y mientras tanto una linea discontinua une el centro del cuerpo con su
sombra.

## El color del borde

El borde de la imagen toma el color de las coordenadas de la normal: la
componente X va al rojo, la Y al verde y la Z al azul, escaladas para que el eje
dominante quede a plena intensidad. Un plano alineado con un eje sale de un tono
puro y uno oblicuo mezcla entre ellos, asi que el color dice de un vistazo hacia
donde mira el plano.

Sobre un volumen cuya rejilla esta alineada con el paciente, el plano de
adquisicion `I-J` (normal K, que apunta a S) sale **azul**, el `I-K` (normal J,
hacia A) sale **verde** y el `J-K` (normal I, hacia R) sale **rojo**.

El grosor del borde dice otra cosa: es fino mientras el plano esta oblicuo y se
engorda en cuanto cae sobre una de las cartesianas de la rejilla, con una
tolerancia de un grado. Se comprueba sobre la geometria, asi que un giro libre
que acierte a caer en una de ellas tambien engorda. Oblicuo, el trazo es de
medio pixel: un pixel a media opacidad, porque WebGL no pinta mas fino.

## La barra de grises

Flotando en la esquina inferior derecha de la vista hay una barra horizontal al
estilo de `icolorbar_demo.html`, puesto de lado: los valores crecen de
izquierda a derecha. No lleva panel ni borde detras; su texto lleva un halo
oscuro para leerse sobre la escena. La barra **es** la funcion de
transferencia: negro por debajo del limite inferior, la rampa entre los dos,
blanco por encima del superior. Encima, un histograma del volumen, de solo
lectura, dice donde esta el dato de verdad, para poder colocar la ventana sobre
el tejido en vez de adivinarla con dos numeros. Debajo van los ticks, con las
cajas de los limites como primero y ultimo.

Al cargar un volumen la ventana abarca todo el rango del dato, del percentil 0
al 100, como en el demo. Desde ahi se ajusta en la propia barra, o con Ctrl +
arrastrar sobre la vista.

Tres detalles del demo son los que hacen que se lea de un vistazo:

- el **histograma se colorea por la ventana**: lo que entra va en tinta viva, lo
  que queda recortado retrocede al color del marco. El histograma muestra asi la
  ventana, sin necesidad de leer dos cifras;
- el **eje vive dentro de la ventana**. Fuera de los limites no hay ticks, y el
  primero y el ultimo de la escala son las propias cajas de los limites, con
  rayita mas gruesa y cifra mas grande. Un tick que caiga a menos de 42 pixeles
  de una caja se descarta para que no se pisen: las cajas van centradas en su
  limite y miden lo que un numero de cinco cifras;
- dos **marcas del rango del dato** en el borde superior de la barra dicen donde
  hay dato de verdad, frente al margen del dominio o a un limite estirado.

Las barras del histograma se escalan contra el percentil 92 de los recuentos por
bin, no contra el maximo. En un volumen medico el bin del aire supera a los de
tejido en ordenes de magnitud, y normalizar por el maximo aplasta todo lo demas
a nada: asi los pocos bins enormes se salen por el extremo y el resto conserva
su forma.

| Gesto | Efecto |
| --- | --- |
| Arrastrar una linea de limite | La mueve, en absoluto: va donde esta el cursor |
| Sacarla por un extremo | Sigue avanzando sola, cada vez mas rapido |
| Alt mientras se arrastra | Ajuste fino, al 15 por ciento de la ganancia |
| Arrastrar el tercio central de las cifras, entre los dos limites | Desplaza los dos limites, ancho intacto |
| Rueda sobre la barra | Ensancha y estrecha la ventana alrededor del valor bajo el cursor |
| Doble clic en un tirador | Lo manda al maximo o al minimo del dato (percentil 100 o 0) |
| Ctrl | Saca las guias de percentiles y el iman se pega a ellas |
| Clic derecho en una cola saturada | Elige el color de esa saturacion |
| Escribir en la caja de un limite | Lo fija a ese valor |
| Boton junto al extremo derecho de la barra (˅ / ˄) | Pliega el histograma sobre la barra y lo despliega, con animacion |
| Pasar por la barra | La aguja marca el valor de ese nivel |
| Shift, sobre la barra o el corte | Dibuja sobre el corte la linea de nivel de ese valor |
| Shift + clic | La deja fijada, con su marca en la barra |
| Pasar por la marca de una fijada | La resalta en naranja, en la barra y en el corte |
| Clic derecho en esa marca | La borra |

Las cajas de los limites son editables: son el primer y el ultimo tick de la
escala, en el mismo sitio y con la misma rayita que los demas, pero se puede
teclear en ellas. Un render de fondo nunca pisa la que se esta editando.

Junto a cada limite va el percentil del dato que deja por debajo. Fuera del
rango del dato no hay percentil que dar, asi que dice `◀ out` o `out ▶` segun
por donde se haya salido.

Con **Ctrl** pulsado aparecen las paradas del iman, en los percentiles 0, 2, 5,
10, 25, 50, 75, 90, 95, 98 y 100, cada una con su tick y su cifra. Las cifras se
colocan con antisolape: primero 0, 50 y 100, luego el resto si dejan 30 pixeles
libres; la parada que no quepa se queda con su tick sin numero. Mientras Ctrl
sigue pulsado, arrastrar un limite lo pega a la parada mas cercana. Los
cuantiles salen de un histograma de 4096 bins con interpolacion dentro del bin,
en vez de ordenar los millones de voxeles del volumen.

El **clic derecho sobre una cola saturada**, o sobre el tirador de ese lado,
abre el dialogo del color de saturacion: la muestra del extremo de la rampa, que
es "ninguno", cuatro colores fijos y el selector del sistema. El color elegido no
solo tine la cola de la barra: tine tambien los voxeles que la ventana recorta
en la imagen, que es lo que permite ver que se esta tirando.

Dos ideas del demo son las que la hacen usable:

- **el dominio es elastico**. La barra no muestra un rango fijo: abarca siempre
  el dato mas un margen, estirado para dar cabida a donde esten los limites.
  Mientras hay un arrastre en curso solo puede abrirse, nunca encogerse, porque
  si no la escala se recalcularia bajo el cursor a mitad de gesto; al soltar,
  vuelve a su tamano natural con una animacion.
- **el auto-avance**. Sacando un limite por el extremo de la barra sigue
  moviendose sin mover mas el raton. La ley va sobre el RANGO, no sobre pixeles:
  la distancia del limite quieto al que se arrastra se multiplica por alpha cada
  segundo, y alpha crece con lo lejos que este el cursor del borde, medido en
  fraccion de la longitud de la barra, de modo que el tacto no depende del
  tamano de la ventana. Un desbordamiento del 15 por ciento vale una duplicacion
  por segundo, con techo en 2^6. Medido: a 15 por ciento el rango se multiplica
  por 2.00 en un segundo, y a 30 por ciento por 4.29 en 1.05 segundos, que es
  4^1.05. Volviendo hacia dentro se encoge igual de rapido, porque cada paso
  re-ancla el arrastre al cursor. Con el limite ya clavado en el borde, acercar
  el raton a la barra desde fuera no lo arrastra: solo cierra el hueco, y el
  tirador se vuelve a enganchar cuando el cursor pasa por su altura.

El cuerpo de la barra no arrastra nada: el desplazamiento de los dos limites
vive en el tercio central de la fila de las cifras, donde el cursor se vuelve
una mano, para dejar libre junto a cada limite su caja editable.

La ventana tambien se cambia desde la vista, con Ctrl + arrastrar. Entonces la
barra hace lo mismo que con un arrastre propio: congela su escala durante el
gesto, de modo que los limites se mueven sobre una escala quieta, y al soltar
la anima hasta el encuadre de los limites finales. Solo se abre a mitad de
gesto si un limite se sale de ella, para que su tirador no abandone la barra.

Junto a cada limite van su valor y el porcentaje de voxeles que satura por ese
lado. La aguja naranja marca el valor de la sonda, es decir el punto del corte
bajo el raton, de modo que se ve en la rampa donde cae lo que se esta mirando.

### Lineas de nivel

Como en el demo, el raton siempre senala un nivel: sobre la barra, el de esa
altura; sobre el corte, el valor bajo el cursor. La aguja lo marca en la barra.
Con **Shift** pulsado, ese nivel se dibuja ademas como una linea de nivel sobre
la imagen, y **Shift + clic**, en la barra o en el corte, la deja fijada. Caben
ocho fijadas. Cada una lleva una marca en la mitad superior de la barra con su
valor; pasar por ella la resalta en naranja tambien sobre la imagen, y el clic
derecho la borra. Las fijadas son del volumen en que se leyeron: al cargar otro
se van.

Las lineas las pinta el shader del corte, sobre el valor ya proyectado, asi que
siguen al slab. La distancia al nivel se mide en pixeles dividiendo por la
derivada en pantalla del valor (`fwidth`), lo que les da el mismo grosor por
empinado que sea el campo. Donde el pixel toca el borde del volumen esa
derivada es el salto al exterior y no el del dato, y ahi no se dibujan.

### Deformar la rampa

Un **doble clic sobre el cuerpo de la barra** pone un nodo sobre la curva, donde
la rampa ya pasa. Arrastrarlo lo mueve por el eje de VALOR mientras el gris que
lleva se queda quieto, que es justo lo que deforma la funcion de transferencia:
se esta diciendo "este gris cae ahora en este valor". La curva se dibuja sobre
la propia barra, con halo oscuro y nucleo blanco, y pasa por (0, limite
inferior), por cada nodo y por (1, limite superior).

Dos clics derechos seguidos sobre un nodo lo borran, y **Ctrl + doble clic**
sobre la barra devuelve la rampa a lineal. Caben hasta ocho nodos, que es el
tope que necesita el bucle del fragment shader.

La deformacion no es cosa solo de la barra: el shader del corte aplica la misma
funcion a trozos, asi que la imagen cambia con ella. Medido sobre el TC de
ejemplo, el brillo medio del corte pasa de 46.8 con la rampa lineal a 68.6 con
dos nodos que empujan los grises medios hacia el extremo claro.

Del demo quedan fuera, a proposito, el dialogo de niveles discretos, el
conmutador de ganancia exponencial del arrastre y la linea de pistas
contextuales; el resto si esta. Los saltos discretos de los limites, como un
valor tecleado o el doble clic en un tirador, se deslizan con el mismo easing
que en el demo.

## Controles

**Raton**

| Accion | Gesto |
| --- | --- |
| Inclinar el plano | Arrastrar el anillo con el boton izquierdo |
| Deslizar el plano por su normal | Arrastrar desde la imagen del corte |
| Orbitar la camara | Arrastrar fuera del plano |
| Cambiar de corte | Rueda sobre el plano (Shift avanza de 5 en 5) |
| Fijar la linea de nivel del valor bajo el cursor | Shift + clic sobre la imagen |
| Acercar la camara | Rueda fuera del plano |
| Ir a un plano cartesiano | Doble clic en una marca de color del anillo, o las teclas I, J y K |
| Ventana / nivel | Ctrl + arrastrar, o boton central fuera del plano |
| Reencuadrar la camara | Doble clic en el vacio |
| Mirar a lo largo de un eje | Clic en la letra R, A o S del marcador de ejes |
| Mirar el corte de frente | Doble clic derecho sobre la imagen |
| Mover el cuerpo | Segun el manipulador elegido en el panel |
| Ajustar el cuerpo a pasos | Shift durante el arrastre, o la casilla del panel |
| Mover el cuerpo a traves del corte | Alt + rueda sobre la imagen, con el arrastre sobre el corte |
| Cancelar el arrastre | Esc |

El reparto es espacial: sobre lo que el plano dibuja el raton manda sobre el
plano, y sobre el vacio manda sobre la camara.

Del teclado solo quedan **I**, **J** y **K**, que llevan el plano a las
cartesianas de la rejilla, y Esc para deshacer el arrastre en curso. Las demas
teclas son modificadores de gestos de raton: Shift para las lineas de nivel,
Ctrl para ventana / nivel y para el iman de percentiles, y Alt para el ajuste
fino de la barra.

En la esquina inferior izquierda hay un marcador de ejes R/A/S que sigue a la
camara y dice hacia donde mira el paciente. Es tambien un control: un clic en
una letra gira la camara, con transicion animada, hasta mirar a lo largo de ese
eje con el apuntando al espectador, es decir desde la derecha, desde delante o
desde arriba; otro clic en la misma letra la lleva al lado opuesto. Desde
arriba y desde abajo la vista deja A hacia arriba y R a la derecha. Arriba y
abajo se quedan a 86 grados, el tope de la orbita, porque la camara mantiene S
como su arriba y en el polo no tendria derecha.

El panel lateral se queda con lo minimo: el volumen de ejemplo y abrir uno
propio, los datos del volumen cargado, el manipulador del cuerpo con su ayuda,
el ajuste a pasos y el boton de recolocar, las opciones de visualizacion y la
ayuda de los gestos.

Las opciones de visualizacion (`src/view-options.ts`) solo tocan el dibujo: el
estilo del cuerpo (silueta, la superficie translucida de antes, las dos, u
oculto), las lineas ocultas y el grosor de la silueta, el contorno rojo, cuando
se ve la caja del volumen, el marcador de ejes y si los manipuladores se
desvanecen. El renderer las lee de `renderer.options` y los controles del cuerpo
la del desvanecido. Se guardan en el `localStorage` del navegador: una
comodidad de quien mira, que si falta o lo rechaza deja los valores por
defecto. Con la superficie, esta se dibuja donde antes, despues del corte y sin
escribir profundidad; la silueta sigue yendo la ultima. La ventana se
lleva entera desde la barra de grises, y el valor bajo el raton se lee en su
aguja. El corte es siempre fino: espesor cero y proyeccion media, que con un
solo punto es el valor interpolado trilinealmente. El shader conserva el slab
(MIP, media y MinIP) por si vuelve a hacer falta.

Tambien acepta ficheros propios: el selector del panel, o arrastrar un `.nii` /
`.nii.gz` sobre las vistas.

## Volumenes de ejemplo

En `public/data`, descargados de
[niivue/niivue-demo-images](https://github.com/niivue/niivue-demo-images)
(licencia BSD-2-Clause, ver `public/data/LICENSE`).

| Fichero | Que es |
| --- | --- |
| `CT_pitch.nii.gz` | TC de craneo adquirido con **gantry inclinado**. Su tercera columna de la affine esta a unos 16 grados de +S, asi que el plano de adquisicion y el axial del paciente no coinciden. Es el caso que mejor muestra para que sirve el MPR. |
| `CT_Abdo.nii.gz` | TC de abdomen, isotropico. |
| `mni152.nii.gz` | Plantilla de RM cerebral MNI152. |

## Estructura

| Fichero | Responsabilidad |
| --- | --- |
| `src/nifti.ts` | Lee la cabecera y los datos, aplica `scl_slope`/`scl_inter`, y expone la affine voxel a mundo. |
| `src/scene.ts` | El plano, el pivote, los planos cartesianos, las transiciones animadas del plano y de la camara, el color direccional, el recorte del plano contra el volumen, la camara 3D, el marcador de ejes y el lanzado de rayos. |
| `src/widget.ts` | El manipulador: el anillo, el ciclo del arrastre y la geometria de las guias. |
| `src/pedestal.ts` | El pedestal del cuerpo: geometria, zonas y gestos que lo mueven en la escena. |
| `src/manip/controls.ts` | Los manipuladores: elige el activo, reparte los eventos y lleva el desvanecido, el ajuste a pasos, las transiciones y la prueba del rayo contra el cuerpo. |
| `src/manip/common.ts` | El contrato de los manipuladores y lo que comparten: espacios, giros, pasos, pruebas de rayos y piezas de dibujo. |
| `src/manip/handles.ts` | Gizmos de flechas, cuadrados, anillos y centro; de ahi salen `plane-gizmo.ts` y `arrows.ts`. |
| `src/manip/slice-drag.ts`, `landmarks.ts`, `trackball.ts`, `cube.ts`, `shadows.ts` | Un manipulador cada uno. |
| `tools/body-from-gltf.mjs` | Genera `public/models/body.json` desde el glTF de Cesium Man. |
| `src/renderer.ts` | WebGL2: textura 3D, shader de reslice, la vista y el dibujo de lineas. |
| `src/interact.ts` | Raton, rueda y las teclas I, J, K y Esc. |
| `src/quantise.ts` | El snap de la normal a los ejes cartesianos de la rejilla. |
| `src/colorbar.ts` | La barra de grises: histograma, limites arrastrables, ticks y aguja. |
| `src/main.ts` | Panel, carga de ficheros y bucle de dibujo. |

`tools/niftiinfo.mjs` imprime dimensiones, espaciado y affine de un fichero:

```
node tools/niftiinfo.mjs public/data/CT_pitch.nii.gz
```

## Notas de implementacion

- El reslice entero ocurre en el fragment shader: por cada pixel se convierte la
  posicion de mundo a coordenadas de textura con la inversa de la affine y se
  deja la interpolacion trilineal al hardware. Un plano oblicuo cuesta
  exactamente lo mismo que uno axial.
- Las coordenadas de mundo son RAS+ en milimetros, la convencion del NIfTI.
- El volumen se sube como `R32F` si la GPU filtra texturas float, y como `R16F`
  si no.
- Solo se carga el primer volumen de un fichero 4D.
- Las etiquetas anatomicas (R/L/A/P/S/I) se calculan de la orientacion real de
  cada direccion, por lo que siguen siendo correctas en oblicuo.
- Las rotaciones repetidas acumulan deriva numerica, asi que la terna se
  reortonormaliza despues de cada una.
- El paso entre cortes se deduce de la rejilla de voxeles proyectada sobre la
  normal, por lo que sigue siendo correcto en adquisiciones anisotropicas y
  oblicuas.
- WebGL limita el grosor de linea a 1 pixel. Las lineas gruesas simples se
  dibujan repitiendo el trazo con un desplazamiento en espacio de clip, y las
  guias del manipulador como cintas de triangulos cuyo ancho se calcula en el
  vertex shader a partir de la direccion del segmento proyectada en pantalla, y
  que el fragment shader sombrea como tubos.
- La camara es ortografica, asi que las aristas paralelas del volumen se ven
  paralelas y el zoom cambia la escala, no la distancia.
- El doble clic derecho no existe en el navegador: se detecta a mano, con dos
  pulsaciones del boton derecho a menos de 400 ms y 6 pixeles. Pone la camara
  mirando a lo largo de la normal del corte desde el lado que ya se veia, con la
  misma transicion que el marcador de ejes.
