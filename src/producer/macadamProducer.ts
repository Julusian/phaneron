/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, isEnd } from 'redioactive'
import { ChanProperties } from '../chanLayer'
import * as Macadam from 'macadam'
import { ToRGBA } from '../process/io'
import { Reader as v210Reader } from '../process/v210'
import Yadif from '../process/yadif'
import { EventEmitter } from 'events'
import { Frame, frame, Filterer, filterer } from 'beamcoder'

export class MacadamProducer implements Producer {
	private readonly id: string
	private params: string[]
	private clContext: nodenCLContext
	private capture: Macadam.CaptureChannel | null = null
	private audFilterer: Filterer | null = null
	private audFilter: RedioPipe<Frame | RedioEnd> | undefined
	private makeSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private toRGBA: ToRGBA | null = null
	private yadif: Yadif | null = null
	private readonly audioChannels = 2
	private running = true
	private paused = false
	private pauseEvent: EventEmitter

	constructor(id: string, params: string[], context: nodenCLContext) {
		this.id = id
		this.params = params
		this.clContext = context
		this.pauseEvent = new EventEmitter()
	}

	async initialise(chanProperties: ChanProperties): Promise<void> {
		if (this.params[0] != 'DECKLINK')
			throw new InvalidProducerError('Macadam producer supports decklink devices')

		const channel = +this.params[1]
		let width = 0
		let height = 0
		try {
			this.capture = await Macadam.capture({
				deviceIndex: channel - 1,
				channels: this.audioChannels,
				sampleRate: Macadam.bmdAudioSampleRate48kHz,
				sampleType: Macadam.bmdAudioSampleType32bitInteger,
				displayMode: Macadam.bmdModeHD1080i50,
				pixelFormat: Macadam.bmdFormat10BitYUV
			})

			this.audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: chanProperties.audioTimebase,
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: 'stereo'
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: 'stereo'
					}
				],
				filterSpec: `[in0:a] asetnsamples=n=960:p=1 [out0:a]`
				// filterSpec: `asetnsamples=n=960:p=1`
			})
			console.log(this.audFilterer.graph.dump())

			width = this.capture.width
			height = this.capture.height

			this.toRGBA = new ToRGBA(this.clContext, '709', '709', new v210Reader(width, height))
			await this.toRGBA.init()

			this.yadif = new Yadif(this.clContext, width, height, 'send_field', 'tff', 'all')
			await this.yadif.init()
		} catch (err) {
			throw new InvalidProducerError(err)
		}

		const frameSource = redio<Macadam.CaptureFrame | RedioEnd>(
			async (push, next) => {
				if (this.capture && this.running) {
					const frame = await this.capture.frame()
					push(frame)
					next()
				} else if (this.capture) {
					push(end)
					next()
					this.capture.stop()
					this.capture = null
				}
			},
			{ bufferSizeMax: 2 }
		)

		const vidFrames = frameSource.fork()
		const audFrames = frameSource.fork()

		this.audFilter = audFrames.valve<Frame | RedioEnd>(
			async (captureFrame: Macadam.CaptureFrame | RedioEnd) => {
				if (isValue(captureFrame) && this.audFilterer) {
					const ffFrame = frame({
						nb_samples: captureFrame.audio.sampleFrameCount,
						format: 's32',
						pts: captureFrame.audio.packetTime,
						sample_rate: 48000,
						channels: this.audioChannels,
						channel_layout: 'stereo',
						data: [Buffer.from(captureFrame.audio.data)]
					})
					const ff = await this.audFilterer.filter([{ name: 'in0:a', frames: [ffFrame] }])
					return ff[0].frames.length > 0 ? ff[0].frames : nil
				} else {
					return captureFrame as RedioEnd
				}
			},
			{ bufferSizeMax: 3, oneToMany: true }
		)

		const vidLoader = vidFrames.valve<OpenCLBuffer[] | RedioEnd>(
			async (frame: Macadam.CaptureFrame | RedioEnd) => {
				if (isValue(frame)) {
					const toRGBA = this.toRGBA as ToRGBA
					const clSources = await toRGBA.createSources()
					const timestamp = frame.video.frameTime / frame.video.frameDuration
					clSources.forEach((s) => (s.timestamp = timestamp))
					await toRGBA.loadFrame(frame.video.data, clSources, this.clContext.queue.load)
					await this.clContext.waitFinish(this.clContext.queue.load)
					return clSources
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		const vidProcess = vidLoader.valve<OpenCLBuffer | RedioEnd>(
			async (clSources: OpenCLBuffer[] | RedioEnd) => {
				if (isValue(clSources)) {
					const toRGBA = this.toRGBA as ToRGBA
					const clDest = await toRGBA.createDest({ width: width, height: height })
					clDest.timestamp = clSources[0].timestamp
					await toRGBA.processFrame(clSources, clDest, this.clContext.queue.process)
					await this.clContext.waitFinish(this.clContext.queue.process)
					clSources.forEach((s) => s.release())
					return clDest
				} else {
					if (isEnd(clSources)) this.toRGBA = null
					return clSources
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		const vidDeint = vidProcess.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					const yadif = this.yadif as Yadif
					const yadifDests: OpenCLBuffer[] = []
					await yadif.processFrame(frame, yadifDests, this.clContext.queue.process)
					await this.clContext.waitFinish(this.clContext.queue.process)
					frame.release()
					return yadifDests.length > 1 ? yadifDests : nil
				} else {
					if (isEnd(frame)) {
						this.yadif?.release()
						this.yadif = null
					}
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: true }
		)

		this.makeSource = vidDeint.valve<OpenCLBuffer | RedioEnd>(
			async (frame: OpenCLBuffer | RedioEnd) => {
				if (isValue(frame)) {
					return frame
				} else {
					return frame
				}
			},
			{ bufferSizeMax: 1, oneToMany: false }
		)

		console.log(`Created Macadam producer ${this.id} for channel ${channel}`)
	}

	getSourceAudio(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audFilter
	}

	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.makeSource
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		console.log(this.id, ': setPaused', this.paused)
		this.pauseEvent.emit('update')
	}

	release(): void {
		this.running = false
	}
}

export class MacadamProducerFactory implements ProducerFactory<MacadamProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(id: string, params: string[]): MacadamProducer {
		return new MacadamProducer(id, params, this.clContext)
	}
}
