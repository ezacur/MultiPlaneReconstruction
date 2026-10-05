# MPR Viewer

Prototipo de reconstruccion multiplanar (MPR) interactiva sobre volumenes NIfTI,
en el navegador. **Una sola vista 3D y un solo plano.** El plano lleva la imagen
resliceada encima y se manipula directamente en el espacio: arranca sobre el
plano de adquisicion, se puede llevar a cualquiera de los planos cartesianos, y
se puede girar a un plano oblicuo arbitrario arrastrandolo.

## Como ejecutarlo

### Requisitos

- **Node.js 20.19 o posterior** (o 22.12 o posterior), con `npm`. Es lo que
  pide Vite 8. Se comprueba con `node -v`.
- Un **navegador con WebGL2**: Chrome, Edge o Firefox recientes. Hace falta la
  aceleracion por hardware activada.

No hace falta instalar nada mas: los volumenes de ejemplo vienen en el repo.

### En desarrollo

Desde la carpeta del proyecto:

```
npm install
npm run dev
```

`npm install` solo hace falta la primera vez, o cuando cambie
`package.json`. `npm run dev` arranca el servidor de Vite y escribe su URL,
normalmente `http://localhost:5173/`. Abrela en el navegador: la app arranca
con el TC de abdomen de ejemplo ya cargado. Cada cambio en `src/` se recarga solo
en la pagina abierta. Para parar el servidor, `Ctrl+C` en la terminal.

Si el puerto 5173 esta ocupado, Vite toma el siguiente libre y lo dice en la
terminal; para fijar uno, `npm run dev -- --port 5180`.

### Version de produccion

```
npm run build
npm run preview
```

`npm run build` comprueba los tipos con TypeScript y deja la app compilada en
`dist/`. `npm run preview` sirve esa carpeta en `http://localhost:4173/` para
probarla tal cual se desplegaria. `dist/` es estatica: vale cualquier servidor
web, pero **no** funciona abriendo `dist/index.html` con doble clic, porque el
navegador no deja descargar los volumenes desde `file://`.

### Tus propios volumenes

Con la app abierta, el selector **Abrir .nii / .nii.gz** del panel, o
arrastrar el fichero sobre la vista. Acepta NIfTI-1 sin comprimir o con gzip;
de un fichero 4D se carga el primer volumen.

Para ver dimensiones, espaciado y affine de un fichero sin abrir la app:

```
node tools/niftiinfo.mjs ruta/al/fichero.nii.gz
```

`tools/quantise-lab.html` es autonomo: se abre directamente en el navegador,
sin servidor ni build.

### Si algo falla

| Sintoma | Causa probable |
| --- | --- |
| "Este navegador no soporta WebGL2" | Aceleracion por hardware desactivada, o navegador antiguo |
| "No se pudo subir el volumen a la GPU" | El volumen supera el tamano maximo de textura 3D de la GPU; el que estaba cargado sigue en pantalla |
| `npm run dev` se queja de la version de Node | Node anterior a 20.19; actualizalo |
| La pagina se queda en blanco tras `npm run build` | Se ha abierto `dist/index.html` desde el disco; usa `npm run preview` |

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

Todo se hace con el raton; no hay atajos de teclado. **Un doble clic sobre una
cara de la caja del volumen** lleva el
plano a la cartesiana paralela a esa cara. Las caras de la caja son justamente
los planos de la rejilla, asi que la cara que se ve de frente es la que se pide.
Al pasar el raton por encima se dibuja el contorno de la cara que se elegiria,
con el color que tomara el plano. Un doble clic fuera de la caja reencuadra la
camara.

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
corte se ve limpio. La caja del volumen se funde con el. Al cargar un volumen
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
| Ir a un plano cartesiano | Doble clic en una cara de la caja del volumen |
| Ventana / nivel | Ctrl + arrastrar, o boton central fuera del plano |
| Reencuadrar la camara | Doble clic fuera de la caja |
| Mirar a lo largo de un eje | Clic en la letra R, A o S del marcador de ejes |
| Mirar el corte de frente | Doble clic derecho sobre la imagen |
| Cancelar el arrastre | Esc |

El reparto es espacial: sobre lo que el plano dibuja el raton manda sobre el
plano, y sobre el vacio manda sobre la camara.

No hay atajos de teclado. Las teclas que quedan son modificadores de gestos de
raton: Shift para las lineas de nivel, Ctrl para ventana / nivel y para el iman
de percentiles, Alt para el ajuste fino de la barra, y Esc para deshacer el
arrastre en curso.

En la esquina inferior izquierda hay un marcador de ejes R/A/S que sigue a la
camara y dice hacia donde mira el paciente. Es tambien un control: un clic en
una letra gira la camara, con transicion animada, hasta mirar a lo largo de ese
eje con el apuntando al espectador, es decir desde la derecha, desde delante o
desde arriba; otro clic en la misma letra la lleva al lado opuesto. Desde
arriba y desde abajo la vista deja A hacia arriba y R a la derecha. Arriba y
abajo se quedan a 86 grados, el tope de la orbita, porque la camara mantiene S
como su arriba y en el polo no tendria derecha.

El panel lateral se queda con lo minimo: el volumen de ejemplo y abrir uno
propio, los datos del volumen cargado y la ayuda de los gestos. La ventana se
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
| `src/renderer.ts` | WebGL2: textura 3D, shader de reslice, la vista y el dibujo de lineas. |
| `src/interact.ts` | Raton, rueda y la tecla Esc. |
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
